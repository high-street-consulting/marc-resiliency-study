# Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\fema_closures.py
# Method-test closure input (methodology 2.3): every OSM edge that touches the FEMA 1% floodplain (NFHL SFHA)
# is given a nominal depth above the threshold, so run_network_analysis closes it. Bridge edges are exempt:
# a bridge sits inside the river's floodplain polygon without being under water at the 1% event.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

COLUMN = "flood_depth_ft_fema_1pct"
NOMINAL_DEPTH_FT = 1.0


def run(cfg=None):
    import arcpy
    cfg = cfg or common.load_config()
    arcpy.env.overwriteOutput = True
    edges = os.path.join(common.repo_path(cfg["paths"]["build_gdb"]), "osm_edges")
    sfha = os.path.join(common.repo_path(cfg["inputs"]["fema_gdb"]), "nfhl_sfha")
    out = common.repo_path(cfg["analysis"]["edge_depth_table"])
    lyr = arcpy.management.MakeFeatureLayer(edges, "fema_closure_edges", "bridge IS NULL OR bridge = 'no'")
    arcpy.management.SelectLayerByLocation(lyr, "INTERSECT", sfha)
    closed = {r[0] for r in arcpy.da.SearchCursor(lyr, ["edge_id"])}
    n = common.write_rows(out, [("edge_id", "TEXT", 40), (COLUMN, "DOUBLE", None)],
                          ([e, NOMINAL_DEPTH_FT if e in closed else None]
                           for e, in arcpy.da.SearchCursor(edges, ["edge_id"])))
    print(f"{out}: {n} edges, {len(closed)} in the FEMA 1% floodplain (bridges exempt) -> {COLUMN}")
    common.write_metadata(
        out, "Edge flood depths", f"{COLUMN}: nominal {NOMINAL_DEPTH_FT} ft on non-bridge OSM edges intersecting the "
        "FEMA NFHL special flood hazard area (SFHA_TF = 'T'); null elsewhere. Fathom columns are added when delivered.",
        ["osm_edges", "FEMA NFHL S_FLD_HAZ_AR"], {"dfirm_ids": cfg["inputs"]["fema_dfirm_ids"]}, [], "fema_closures.py")
    return out


if __name__ == "__main__":
    run()
