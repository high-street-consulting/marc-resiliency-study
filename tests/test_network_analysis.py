r"""Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I tests\test_network_analysis.py"""
import datetime
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import arcpy
import build_osm_graph as bog
import common
import run_network_analysis as rna

CFG = common.load_config()
X, Y = -94.60, 39.00
P = {1: (X, Y), 2: (X + 0.01, Y), 3: (X + 0.01, Y + 0.01), 4: (X, Y + 0.01),
     11: (X + 0.02, Y), 12: (X + 0.02, Y + 0.01), 5: (X - 0.005, Y + 0.01)}
# Main ring 1-2-3-4; a neighborhood (11, 12) reached by two crossings; a cul-de-sac off node 4.
WAYS = [(osm_id, {"highway": "residential"}, [(n, *P[n]) for n in nodes]) for osm_id, nodes in (
    (100, [1, 2, 3, 4, 1]), (200, [2, 11]), (201, [3, 12]), (202, [11, 12]), (203, [4, 5]))]


def build():
    out_dir = os.path.join(HERE, "output", datetime.date.today().isoformat())
    gdb = common.ensure_gdb(os.path.join(out_dir, "test_network_analysis.gdb"))
    scratch, keep = common.setup_scratch(CFG)
    fc = os.path.join(gdb, "osm_edges")
    _, g, _, _ = bog.build_from_ways(WAYS, CFG, fc, os.path.join(out_dir, "analysis_graph.pkl"), scratch, keep)
    return gdb, fc, g


def test_scenarios():
    gdb, fc, g = build()
    edge_len = {k: d["length_m"] for _, _, k, d in g.edges(keys=True, data=True)}
    edge_tract = {"RD_202_0": "T1", "RD_100_0": "T1"}
    tract_len = {"T1": edge_len["RD_202_0"] + edge_len["RD_100_0"]}
    tracts = {"T1": {"population": 1000, "jobs": 50, "elderly_share": 0.2, "child_share": 0.3, "mobility_disab_pct": 10}}

    edges, zones, det = rna.analyze_scenario(g, frozenset({"RD_200_0"}), edge_tract, tract_len, tracts, {"f1": "RD_202_0"})
    assert [z["zone_type"] for z in zones] == ["single_egress"], zones
    z = zones[0]
    assert z["egress_baseline"] == 2 and z["egress_scenario"] == 1 and z["edge_ids"] == ["RD_202_0"]
    assert abs(z["population"] - 1000 * edge_len["RD_202_0"] / tract_len["T1"]) < 0.1
    assert z["facilities"] == 1 and abs(z["elderly_share"] - 0.2) < 1e-9
    expect = (edge_len["RD_100_1"] + edge_len["RD_201_0"] + edge_len["RD_202_0"]) / rna.M_PER_MI
    assert abs(edges["RD_200_0"]["detour_mi"] - expect) < 1e-6 and edges["RD_200_0"]["closed"] == 1
    assert det["RD_200_0"][1] == ["RD_100_1", "RD_201_0", "RD_202_0"]
    assert not any(e["stranded"] for e in edges.values())
    rna.write_outputs(gdb, fc, "test_single", [(0.5, edges, zones, det)])
    assert int(arcpy.management.GetCount(os.path.join(gdb, "detours_test_single"))[0]) == 1

    edges, zones, det = rna.analyze_scenario(g, frozenset({"RD_200_0", "RD_201_0"}))
    assert [z["zone_type"] for z in zones] == ["stranded"] and zones[0]["egress_baseline"] == 2
    assert edges["RD_202_0"]["stranded"] == 1 and edges["RD_200_0"]["detour_mi"] is None
    rna.write_outputs(gdb, fc, "test_stranded", [(0.5, edges, zones, det)])
    assert int(arcpy.management.GetCount(os.path.join(gdb, "stranded_zones_test_stranded"))[0]) == 1


def test_threshold_ladder():
    depths = {"a": 0.4, "b": 1.2, "c": None}
    assert rna.closed_edges(depths, 0.5) == {"b"} and rna.closed_edges(depths, 1.5) == frozenset()
    gdb, fc, g = build()
    runs = [(0.5, *rna.analyze_scenario(g, frozenset({"RD_200_0"}))),
            (2.0, *rna.analyze_scenario(g, frozenset({"RD_200_0", "RD_201_0"})))]
    rna.write_outputs(gdb, fc, "test_ladder", runs)
    out = os.path.join(gdb, "stranded_zones_test_ladder")
    assert int(arcpy.management.GetCount(out)[0]) == 2
    assert sum(1 for _ in arcpy.da.SearchCursor(out, ["OID@"], where_clause="threshold_ft = 2.0")) == 1


def test_baseline_island_is_not_stranded():
    _, _, g = build()
    g.add_edge(90, 91, key="RD_900_0", u=90, v=91, length_m=100.0, oneway="")  # OSM fragment off the main graph
    _, zones, _ = rna.analyze_scenario(g, frozenset())
    assert zones == [], zones
    _, zones, _ = rna.analyze_scenario(g, frozenset({"RD_200_0", "RD_201_0"}))
    assert [z["zone_type"] for z in zones] == ["stranded"] and "RD_900_0" not in zones[0]["edge_ids"]


def test_oneway_detour_and_centrality():
    _, _, g = build()
    for u, v, k, d in g.edges(keys=True, data=True):
        if k == "RD_100_1":
            d["oneway"] = "-1"
        if k == "RD_100_2":
            d["oneway"] = "yes"
    _, _, det = rna.analyze_scenario(g, frozenset({"RD_200_0"}))
    assert det["RD_200_0"][0] is None, "both ways from 2 to 3 run against one-ways"
    cent = rna.centrality(g, 50, 42)
    assert set(cent) == {k for _, _, k in g.edges(keys=True)} and cent["RD_203_0"] > 0



def test_redundancy():
    _, _, g = build()
    red = rna.redundancy(g, ["RD_100_0", "RD_203_0"], CFG["analysis"]["redundancy_cutoff_mi"])
    lens = {k: d["length_m"] for _, _, k, d in g.edges(keys=True, data=True)}
    three_sides = (lens["RD_100_1"] + lens["RD_100_2"] + lens["RD_100_3"]) / rna.M_PER_MI
    three_sides_alt = (lens["RD_100_3"] + lens["RD_100_2"] + lens["RD_201_0"] + lens["RD_202_0"] + lens["RD_200_0"]) / rna.M_PER_MI
    assert abs(red["RD_100_0"] - min(three_sides, three_sides_alt)) < 1e-9 and abs(red["RD_100_0"] - three_sides) < 1e-9
    assert red["RD_203_0"] is None, "cul-de-sac is a graph bridge: no surviving path"
    assert g.number_of_edges() == 8 and rna.directed(g).number_of_edges() == 16


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
