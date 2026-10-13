# Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\results_to_sections.py
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
import lrs
import run_network_analysis as rna

RID = "route_id"


def edge_events(events_table):
    import arcpy
    return {eid: (rid, a, b) for eid, rid, a, b in arcpy.da.SearchCursor(events_table, ["edge_id", RID, "from_m", "to_m"])}


def results_to_sections(targets, links, edge_values, rules):
    # edge_values: {edge_id: {attr: value}}; links: {edge_id: (route_id, from_m, to_m)}
    events = [(links[e][0], links[e][1], links[e][2], v) for e, v in edge_values.items() if e in links]
    return lrs.aggregate(targets, events, rules)


def haz_skeleton(old_haz, out_table, asset_ids, layer="scored_sections"):
    # New HAZ_* rows keyed on section asset_id, same columns as the ICF table, values empty.
    import arcpy
    if arcpy.Exists(out_table):
        arcpy.management.Delete(out_table)
    arcpy.management.CreateTable(os.path.dirname(out_table), os.path.basename(out_table), template=old_haz)
    with arcpy.da.InsertCursor(out_table, ["asset_id", "asset_layer"]) as cur:
        for a in asset_ids:
            cur.insertRow([a, layer])


def run(cfg=None):
    import arcpy
    cfg = cfg or common.load_config()
    common.setup_scratch(cfg)
    gdb = common.repo_path(cfg["paths"]["build_gdb"])
    sections = os.path.join(gdb, "scored_sections")
    targets = list(arcpy.da.SearchCursor(sections, ["asset_id", RID, "begin_point", "end_point"]))
    ev = os.path.join(gdb, "edge_lrs_events")
    links = edge_events(ev) if arcpy.Exists(ev) else {}
    if not links:
        print(f"no edge linkage in {ev}: OSM results cannot reach sections; writing the HAZ skeleton only")

    values, rules = {}, {}
    cent = os.path.join(gdb, "edge_centrality")
    if arcpy.Exists(cent):
        for e, v in arcpy.da.SearchCursor(cent, ["edge_id", "centrality"]):
            values.setdefault(e, {})["centrality"] = v
        rules["centrality"] = "mean"
    for s in cfg["analysis"]["scenarios"]:
        name = rna.scenario_name(s)
        t = os.path.join(gdb, f"edge_results_{name}")
        if not arcpy.Exists(t):
            print(f"skip {name}: no {t}")
            continue
        for e, c, st, d in arcpy.da.SearchCursor(t, ["edge_id", "closed", "stranded", "detour_mi"]):
            values.setdefault(e, {}).update({f"closed_{name}": c, f"stranded_{name}": st, f"detour_mi_{name}": d})
        rules.update({f"closed_{name}": "max", f"stranded_{name}": "max", f"detour_mi_{name}": "max"})
    agg = results_to_sections(targets, links, values, rules)

    existing = {f.name for f in arcpy.ListFields(sections)}
    for attr in rules:
        if attr not in existing:
            arcpy.management.AddField(sections, attr, "DOUBLE")
    with arcpy.da.UpdateCursor(sections, ["asset_id"] + list(rules)) as cur:
        for row in cur:
            r = agg.get(row[0], {})
            row[1:] = [r.get(a) for a in rules]
            cur.updateRow(row)

    src = common.repo_path(cfg["paths"]["source_gdb"])
    haz = os.path.join(gdb, "HAZ_scored_sections")
    haz_skeleton(os.path.join(src, cfg["analysis"]["haz_table"]), haz, [t[0] for t in targets])
    print(f"sections updated: {len(targets)}; HAZ skeleton rows: {len(targets)} -> {haz}")
    return sections


if __name__ == "__main__":
    run()
