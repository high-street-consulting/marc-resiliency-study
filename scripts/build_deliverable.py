# Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\build_deliverable.py
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

# deliverable name -> build-gdb source (same layer names as the delivered gdb, new schemas)
REPLACE = {
    "stranded_zone_network": "osm_edges",
    "vulnerability_assessment_network": "scored_sections",
    "HAZ_vulnerability_assessment_network": "HAZ_scored_sections",
}
NEW = ["hpms_routes", "hpms_route_qc", "edge_lrs_events"]
NOTES = {
    "stranded_zone_network": ("OpenStreetMap (Geofabrik extract)", "Analysis graph: stranded zones, detours, centrality",
                              "Schema change: OSM ways split at shared nodes (osm_edges); see docs/inputs.md"),
    "vulnerability_assessment_network": ("FHWA HPMS 2024", "Tier 1 scored network",
                                         "Schema change: HPMS sections (scored_sections) keyed on asset_id = Route_ID_Begin_End"),
}


def run(cfg=None):
    import arcpy
    cfg = cfg or common.load_config()
    common.setup_scratch(cfg)
    sr = common.spatial_ref(cfg)
    src = common.repo_path(cfg["paths"]["source_gdb"])
    build = common.repo_path(cfg["paths"]["build_gdb"])
    out = common.repo_path(cfg["paths"]["deliverable_gdb"])
    if arcpy.Exists(out):
        arcpy.management.Delete(out)
    common.ensure_gdb(out)

    arcpy.env.workspace = src
    for ds in arcpy.ListDatasets(feature_type="Feature") or []:
        arcpy.management.CreateFeatureDataset(out, ds, sr)
        for fc in arcpy.ListFeatureClasses(feature_dataset=ds) or []:
            target = os.path.join(out, ds, fc)
            new = os.path.join(build, REPLACE.get(fc, ""))
            if fc in REPLACE and arcpy.Exists(new):
                arcpy.management.Project(new, target, sr)
                ds_, role, note = NOTES[fc]
                for f, v in (("data_source", ds_), ("framework_role", role), ("source_note", note)):
                    if f not in {x.name for x in arcpy.ListFields(target)}:
                        arcpy.management.AddField(target, f, "TEXT", field_length=255)
                    arcpy.management.CalculateField(target, f, repr(v), "PYTHON3")
                print(f"{ds}/{fc}: replaced by {REPLACE[fc]}")
            else:
                if fc in REPLACE:
                    print(f"WARNING {ds}/{fc}: {REPLACE[fc]} not built; carrying the delivered layer")
                arcpy.management.Project(os.path.join(src, ds, fc), target, sr)
    for t in arcpy.ListTables() or []:
        new = os.path.join(build, REPLACE.get(t, ""))
        if t in REPLACE and arcpy.Exists(new):
            arcpy.management.Copy(new, os.path.join(out, t))
            print(f"{t}: replaced by {REPLACE[t]}")
        else:
            arcpy.management.Copy(os.path.join(src, t), os.path.join(out, t))
    arcpy.env.workspace = build
    extra = NEW + (arcpy.ListTables("ev_*") or [])
    for name in extra:
        p = os.path.join(build, name)
        if not arcpy.Exists(p):
            print(f"WARNING {name}: not built")
            continue
        if arcpy.Describe(p).dataType == "FeatureClass":
            arcpy.management.Project(p, os.path.join(out, name), sr)
        else:
            arcpy.management.Copy(p, os.path.join(out, name))

    aliases = common.load_aliases()
    scenarios = cfg["analysis"].get("scenarios", [])
    arcpy.env.workspace = out
    targets = [os.path.join(ds, fc) for ds in arcpy.ListDatasets(feature_type="Feature") or []
               for fc in arcpy.ListFeatureClasses(feature_dataset=ds) or []]
    targets += (arcpy.ListFeatureClasses() or []) + (arcpy.ListTables() or [])
    for t in targets:
        p = os.path.join(out, t)
        demoted = common.demote_new_types(p)
        print(f"{t}: {demoted} fields demoted to classic types, {common.apply_aliases(p, aliases, scenarios)} aliases")
    print(f"deliverable: {out}")
    return out


if __name__ == "__main__":
    run()
