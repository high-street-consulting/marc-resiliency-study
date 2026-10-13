# Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\build_osm_graph.py
import math
import os
import pickle
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

FIELDS = [
    ("edge_id", "TEXT", 40), ("osm_id", "BIGINTEGER", None), ("u", "BIGINTEGER", None),
    ("v", "BIGINTEGER", None), ("highway", "TEXT", 20), ("ref", "TEXT", 60), ("name", "TEXT", 120),
    ("oneway", "TEXT", 8), ("bridge", "TEXT", 20), ("layer", "TEXT", 8), ("maxspeed", "TEXT", 20),
    ("length_m", "DOUBLE", None),
]
TAGS = ("highway", "ref", "name", "oneway", "bridge", "layer", "maxspeed")


def read_ways(pbf_paths, bbox=None):
    # Yields (osm_id, tags, [(node_id, lon, lat), ...]) for every way with a highway tag.
    try:
        import osmium
    except ImportError:
        raise RuntimeError(
            "No PBF reader with node references in this env: osmnx cannot read PBF, pyrosm is not "
            "installed, and neither is osmium. Install pyosmium (conda-forge) in a clone of "
            "arcgispro-py3 and run this step with that clone."
        )
    for path in pbf_paths:
        fp = osmium.FileProcessor(path).with_locations().with_filter(osmium.filter.KeyFilter("highway"))
        for obj in fp:
            if not obj.is_way():
                continue
            nodes = [(n.ref, n.lon, n.lat) for n in obj.nodes if n.location.valid()]
            if len(nodes) < 2:
                continue
            if bbox and not any(bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3] for _, x, y in nodes):
                continue
            yield obj.id, dict(obj.tags), nodes


def keep_way(tags, cfg):
    o = cfg["osm"]
    return (
        tags.get("highway") in o["highway"]
        and tags.get("access") not in o["drop_access"]
        and tags.get("service") not in o["drop_service"]
        and tags.get("area") != "yes"
    )


def haversine_m(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 12742000.0 * math.asin(math.sqrt(h))


def split_ways(ways):
    # Node identity decides a junction: split at every node used by 2+ kept ways (or twice by one way).
    ways = list(ways)
    use = Counter()
    for _, _, nodes in ways:
        use.update(n[0] for n in nodes)
    edges = []
    for osm_id, tags, nodes in ways:
        k, start = 0, 0
        for i in range(1, len(nodes)):
            if i == len(nodes) - 1 or use[nodes[i][0]] > 1:
                part = nodes[start:i + 1]
                coords = [(x, y) for _, x, y in part]
                edges.append({
                    "edge_id": f"RD_{osm_id}_{k}", "osm_id": osm_id, "u": part[0][0], "v": part[-1][0],
                    "coords": coords, "nodes": [n for n, _, _ in part],
                    "length_m": sum(haversine_m(coords[j], coords[j + 1]) for j in range(len(coords) - 1)),
                    **{t: tags.get(t) for t in TAGS},
                })
                k, start = k + 1, i
    return edges


def interior_junctions(edges):
    # Nodes interior to one edge that also appear in any other edge; must be zero.
    seen = Counter()
    for e in edges:
        seen.update(set(e["nodes"]))
    return sum(1 for e in edges for n in e["nodes"][1:-1] if seen[n] > 1)


def build_graph(edges):
    import networkx as nx
    g = nx.MultiGraph()
    for e in edges:
        g.add_edge(e["u"], e["v"], key=e["edge_id"], edge_id=e["edge_id"], oneway=e["oneway"], u=e["u"], v=e["v"],
                   highway=e["highway"], length_m=e["length_m"], coords=e["coords"])
    return g


def giant_share(g):
    import networkx as nx
    total = sum(d["length_m"] for _, _, d in g.edges(data=True))
    if not total:
        return 0.0
    best = max(nx.connected_components(g), key=len)
    return sum(d["length_m"] for _, _, d in g.subgraph(best).edges(data=True)) / total


def write_edges(edges, out_fc, sr_out, scratch, keep, study_area=None, sr_in=None):
    import arcpy
    sr_in = sr_in or arcpy.SpatialReference(4326)
    tmp = os.path.join(scratch, "osm_edges_source")
    arcpy.management.CreateFeatureclass(scratch, "osm_edges_source", "POLYLINE", spatial_reference=sr_in)
    for name, typ, length in FIELDS:
        arcpy.management.AddField(tmp, name, typ, field_length=length)
    names = [f[0] for f in FIELDS]
    with arcpy.da.InsertCursor(tmp, ["SHAPE@"] + names) as cur:
        for e in edges:
            line = arcpy.Polyline(arcpy.Array([arcpy.Point(x, y) for x, y in e["coords"]]), sr_in)
            cur.insertRow([line] + [e[n] for n in names])
    projected = os.path.join(scratch, "osm_edges_projected")
    arcpy.management.Project(tmp, projected, sr_out)
    if study_area:
        lyr = arcpy.management.MakeFeatureLayer(projected, "osm_edges_lyr")
        arcpy.management.SelectLayerByLocation(lyr, "INTERSECT", study_area)
        arcpy.management.CopyFeatures(lyr, out_fc)
        arcpy.management.Delete(lyr)
    else:
        arcpy.management.CopyFeatures(projected, out_fc)
    common.cleanup([tmp, projected], keep)
    return {r[0] for r in arcpy.da.SearchCursor(out_fc, ["edge_id"])}


def add_node_xy(g, edges, sr_in, sr_out):
    # Projected node coordinates, for detour geometry.
    import arcpy
    for e in edges:
        for n, (x, y) in ((e["u"], e["coords"][0]), (e["v"], e["coords"][-1])):
            if "x" not in g.nodes[n]:
                p = arcpy.PointGeometry(arcpy.Point(x, y), sr_in).projectAs(sr_out).firstPoint
                g.nodes[n]["x"], g.nodes[n]["y"] = p.X, p.Y


def build_from_ways(ways, cfg, out_fc, pkl, scratch, keep, study_area=None, sr_in=None):
    import arcpy
    sr_in = sr_in or arcpy.SpatialReference(4326)
    edges = split_ways(w for w in ways if keep_way(w[1], cfg))
    kept_ids = write_edges(edges, out_fc, common.spatial_ref(cfg), scratch, keep, study_area, sr_in)
    edges = [e for e in edges if e["edge_id"] in kept_ids]
    g = build_graph(edges)
    add_node_xy(g, edges, sr_in, common.spatial_ref(cfg))
    os.makedirs(os.path.dirname(pkl), exist_ok=True)
    with open(pkl, "wb") as f:
        pickle.dump(g, f, protocol=pickle.HIGHEST_PROTOCOL)
    bad = interior_junctions(edges)
    share = giant_share(g)
    print(f"edges: {len(edges)}  interior-vertex junctions: {bad}  giant component share of length: {share:.4f}")
    return edges, g, bad, share


def run(cfg=None):
    import arcpy
    cfg = cfg or common.load_config()
    scratch, keep = common.setup_scratch(cfg)
    src = common.repo_path(cfg["paths"]["source_gdb"])
    study_area = os.path.join(src, cfg["inputs"]["study_area"])
    ext = arcpy.Describe(study_area).extent.projectAs(arcpy.SpatialReference(4326))
    bbox = (ext.XMin - 0.05, ext.YMin - 0.05, ext.XMax + 0.05, ext.YMax + 0.05)
    pbfs = [common.repo_path(p) for p in cfg["inputs"]["pbf"]]
    out_fc = os.path.join(common.ensure_gdb(common.repo_path(cfg["paths"]["build_gdb"])), "osm_edges")
    pkl = common.repo_path(cfg["paths"]["graph_pickle"])

    _, _, bad, share = build_from_ways(read_ways(pbfs, bbox), cfg, out_fc, pkl, scratch, keep, study_area)
    common.write_metadata(
        out_fc, "OSM analysis network (osm_edges)",
        "Drivable public OSM roads split at every shared node; routable analysis graph for stranded zones, "
        "detours and centrality.",
        sources=[os.path.basename(p) for p in pbfs],
        params={"highway": ",".join(cfg["osm"]["highway"]), "drop_access": cfg["osm"]["drop_access"],
                "drop_service": cfg["osm"]["drop_service"], "wkid": cfg["crs"]["wkid"]},
        outputs=[out_fc, pkl], script="build_osm_graph.py")
    if bad or share < cfg["osm"]["min_giant_share"]:
        raise RuntimeError(f"OSM graph checks failed: interior junctions {bad}, giant share {share:.4f}")
    return out_fc, pkl


if __name__ == "__main__":
    run()
