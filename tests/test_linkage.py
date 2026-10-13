r"""Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I tests\test_linkage.py"""
import csv
import datetime
import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import arcpy
import build_osm_graph as bog
import common
import link_edges_to_routes as link

CFG = common.load_config()
SR = common.spatial_ref(CFG)
FT_MI = 5280.0
X0, Y0 = 2750000.0, 1050000.0

# (route_id, facility_type, route_number, route_name, [(x, y, m)])
ROUTES = [
    ("FWY_NB", 6, 35, "I-35", [(X0, Y0, 0.0), (X0, Y0 + 2 * FT_MI, 2.0)]),
    ("FWY_SB", 6, 35, "I-35", [(X0 + 80, Y0 + 2 * FT_MI, 0.0), (X0 + 80, Y0, 2.0)]),
    ("ART_95", 2, None, "95TH ST", [(X0 - 2000, Y0 + FT_MI, 0.0), (X0 + 3000, Y0 + FT_MI, 5000 / FT_MI)]),
    ("RAMP_1", 4, None, None, [(X0 + 150, Y0 + 2000, 0.0), (X0 + 600, Y0 + 2600, 750 / FT_MI)]),
]
Y95 = Y0 + FT_MI
# (edge_id, highway, ref, name, oneway, [(x, y)], expected (route, method) or None)
EDGES = [
    ("e_nb", "motorway", "I 35", None, "yes", [(X0 + 5, Y0 + 1000), (X0 + 5, Y0 + 3000)], ("FWY_NB", "span", "high")),
    ("e_sb", "motorway", "I 35", None, "yes", [(X0 + 75, Y0 + 3000), (X0 + 75, Y0 + 1000)], ("FWY_SB", "span", "high")),
    ("e_95", "secondary", None, "W 95th St", None, [(X0 + 200, Y95 + 10), (X0 + 2200, Y95 + 10)], ("ART_95", "span", "high")),
    ("e_cross", "residential", None, None, None, [(X0 + 300, Y95 - 40), (X0 + 300, Y95 + 40)], None),
    ("e_ramp", "motorway_link", None, None, "yes", [(X0 + 150, Y0 + 2005), (X0 + 600, Y0 + 2605)], ("RAMP_1", "span", "medium")),
    ("e_ramp_orphan", "motorway_link", None, None, "yes", [(X0 + 9000, Y0), (X0 + 9500, Y0 + 500)], None),
    ("e_far", "residential", None, "Elm St", None, [(X0 + 9000, Y0 + 9000), (X0 + 9500, Y0 + 9000)], None),
    ("e_zigzag", "secondary", None, None, None,
     [(X0 + 2300, Y95), (X0 + 2350, Y95 + 50), (X0 + 2450, Y95 + 50), (X0 + 2500, Y95)], ("ART_95", "radius", "low")),
]


def build_inputs(gdb):
    routes = os.path.join(gdb, "hpms_routes")
    if arcpy.Exists(routes):
        arcpy.management.Delete(routes)
    arcpy.management.CreateFeatureclass(gdb, "hpms_routes", "POLYLINE", has_m="ENABLED", spatial_reference=SR)
    for f, t in (("route_id", "TEXT"), ("facility_type", "SHORT"), ("route_number", "LONG"), ("route_name", "TEXT")):
        arcpy.management.AddField(routes, f, t)
    with arcpy.da.InsertCursor(routes, ["SHAPE@", "route_id", "facility_type", "route_number", "route_name"]) as cur:
        for rid, ft, num, name, pts in ROUTES:
            arr = arcpy.Array([arcpy.Point(x, y, None, m) for x, y, m in pts])
            cur.insertRow([arcpy.Polyline(arr, SR, False, True), rid, ft, num, name])
    edges = os.path.join(gdb, "osm_edges")
    common.write_rows(
        edges, bog.FIELDS,
        ([arcpy.Polyline(arcpy.Array([arcpy.Point(x, y) for x, y in pts]), SR), eid, 0, 0, 0, hw, ref, name, ow,
          None, None, None, 0.0] for eid, hw, ref, name, ow, pts, _ in EDGES),
        "POLYLINE", SR)
    return edges, routes


def previous_qc(out_dir):
    current = os.path.join(out_dir, "linkage_qc.csv")
    if os.path.exists(current):
        return current
    older = sorted(p for p in glob.glob(os.path.join(HERE, "output", "*", "linkage_qc.csv")) if p != current)
    return older[-1] if older else None


def write_and_diff(rows, out_dir):
    prev = previous_qc(out_dir)
    old = {}
    if prev:
        with open(prev, newline="") as f:
            old = {r["edge_id"]: r for r in csv.DictReader(f)}
    path = os.path.join(out_dir, "linkage_qc.csv")
    fields = ["edge_id", "route", "span_mi", "quality", "method"]
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    with open(path, newline="") as f:
        new = {r["edge_id"]: r for r in csv.DictReader(f)}
    changed = [k for k in sorted(set(old) | set(new)) if old.get(k) != new.get(k)]
    print(f"QC CSV: {path}; previous: {prev or 'none'}; changed rows: {len(changed) if prev else 'n/a'}")
    for k in changed if prev else []:
        print(f"  {k}: {old.get(k)} -> {new.get(k)}")


def test_linkage():
    out_dir = os.path.join(HERE, "output", datetime.date.today().isoformat())
    gdb = common.ensure_gdb(os.path.join(out_dir, "test_linkage.gdb"))
    scratch, keep = common.setup_scratch(CFG)
    edges_fc, routes_fc = build_inputs(gdb)
    events = os.path.join(gdb, "edge_lrs_events")
    edges, results = link.link(edges_fc, routes_fc, events, CFG, scratch, keep)
    link.coverage_report(edges, results, CFG["linkage"])
    rows = []
    for eid, hw, ref, name, ow, pts, expected in EDGES:
        got = results.get(eid)
        rows.append({"edge_id": eid, "route": got[0] if got else "", "span_mi": f"{abs(got[2] - got[1]):.4f}" if got else "",
                     "quality": got[3] if got else "", "method": got[4] if got else ""})
        actual = (got[0], got[4], got[3]) if got else None
        assert actual == expected, f"{eid}: expected {expected}, got {actual}"
    write_and_diff(rows, out_dir)
    fields = [r[0] for r in arcpy.da.SearchCursor(edges_fc, ["edge_id", "lrs_route_id"]) if r[1]]
    assert sorted(fields) == sorted(results)
    assert int(arcpy.management.GetCount(events)[0]) == len(results)
    nb = results["e_nb"]
    assert abs(nb[1] - 1000 / FT_MI) < 0.002 and abs(nb[2] - 3000 / FT_MI) < 0.002


if __name__ == "__main__":
    test_linkage()
    print("PASS test_linkage")
