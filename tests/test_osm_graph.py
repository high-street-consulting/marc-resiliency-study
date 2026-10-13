r"""Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I tests\test_osm_graph.py"""
import datetime
import os
import pickle
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import build_osm_graph as bog
import common

CFG = common.load_config()

# Hand-built network near the I-35/I-435 interchange (lon/lat).
# I-435 runs west-east; I-35 crosses it at the same x/y on its own node (overpass, no shared node).
# One ramp joins them; a residential pair crosses at an interior node; private and parking ways are dropped.
WAYS = [
    (435, {"highway": "motorway", "ref": "I 435", "oneway": "yes"},
     [(1, -94.760, 38.950), (2, -94.750, 38.950), (3, -94.740, 38.950), (4, -94.730, 38.950), (5, -94.720, 38.950)]),
    (35, {"highway": "motorway", "ref": "I 35;US 50", "oneway": "yes", "bridge": "yes", "layer": "1"},
     [(11, -94.750, 38.940), (12, -94.745, 38.945), (13, -94.740, 38.950), (14, -94.735, 38.955), (15, -94.730, 38.960)]),
    (900, {"highway": "motorway_link", "oneway": "yes"}, [(2, -94.750, 38.950), (16, -94.748, 38.946), (12, -94.745, 38.945)]),
    (901, {"highway": "motorway_link", "oneway": "yes"}, [(14, -94.735, 38.955), (17, -94.732, 38.952), (4, -94.730, 38.950)]),
    (700, {"highway": "residential", "name": "W 95th St"},
     [(5, -94.720, 38.950), (21, -94.715, 38.950), (22, -94.710, 38.950), (23, -94.705, 38.950)]),
    (701, {"highway": "residential", "name": "Pflumm Rd"},
     [(31, -94.710, 38.955), (22, -94.710, 38.950), (33, -94.710, 38.945)]),
    (702, {"highway": "residential", "access": "private"}, [(23, -94.705, 38.950), (41, -94.700, 38.950)]),
    (703, {"highway": "service", "service": "parking_aisle"}, [(21, -94.715, 38.950), (42, -94.715, 38.952)]),
]


def refs(ref):
    return {r.strip() for r in (ref or "").split(";")}


def no_shared_node(edges, ref_a, ref_b):
    a = {n for e in edges if ref_a in refs(e["ref"]) for n in (e["u"], e["v"])}
    b = {n for e in edges if ref_b in refs(e["ref"]) for n in (e["u"], e["v"])}
    return not (a & b)


def test_hand_built_graph():
    out_dir = os.path.join(HERE, "output", datetime.date.today().isoformat())
    gdb = common.ensure_gdb(os.path.join(out_dir, "test_osm_graph.gdb"))
    scratch, keep = common.setup_scratch(CFG)
    edges, g, bad, share = bog.build_from_ways(
        WAYS, CFG, os.path.join(gdb, "osm_edges"), os.path.join(out_dir, "osm_graph.pkl"), scratch, keep)
    ids = {e["edge_id"] for e in edges}
    assert bad == 0, bad
    assert share >= CFG["osm"]["min_giant_share"], share
    assert not ids & {"RD_702_0", "RD_703_0"}, "private road and parking aisle must be dropped"
    assert {"RD_435_0", "RD_435_1", "RD_435_2"} <= ids and "RD_435_3" not in ids
    assert {"RD_700_0", "RD_700_1"} <= ids and {"RD_701_0", "RD_701_1"} <= ids
    assert no_shared_node(edges, "I 35", "I 435")
    assert g.number_of_edges() == len(edges) and all("x" in g.nodes[n] for n in g.nodes)


def test_isolated_piece_lowers_giant_share():
    edges = bog.split_ways(WAYS[:2])
    assert bog.giant_share(bog.build_graph(edges)) < 1.0


def test_real_build_if_present():
    pkl = common.repo_path(CFG["paths"]["graph_pickle"])
    fc = os.path.join(common.repo_path(CFG["paths"]["build_gdb"]), "osm_edges")
    if not os.path.exists(pkl):
        print("SKIP real build: no graph pickle (run scripts/build_osm_graph.py first)")
        return
    import arcpy
    with open(pkl, "rb") as f:
        g = pickle.load(f)
    share = bog.giant_share(g)
    assert share >= CFG["osm"]["min_giant_share"], share
    edges = [{"u": u, "v": v, "ref": r} for u, v, r in arcpy.da.SearchCursor(fc, ["u", "v", "ref"], "highway = 'motorway'")]
    assert no_shared_node(edges, "I 35", "I 435")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
