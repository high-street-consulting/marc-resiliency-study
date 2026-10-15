# Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\build_osm_graph.py
import math
import os
import pickle
import struct
import sys
import time
import zlib
from collections import Counter

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

FIELDS = [
    # OSM ids exceed 32 bits; stored as TEXT because Esri's 64-bit integer type is banned (global CLAUDE.md).
    ("edge_id", "TEXT", 40), ("osm_id", "TEXT", 20), ("u", "TEXT", 20),
    ("v", "TEXT", 20), ("highway", "TEXT", 20), ("ref", "TEXT", 60), ("name", "TEXT", 120),
    ("oneway", "TEXT", 8), ("bridge", "TEXT", 20), ("layer", "TEXT", 8), ("maxspeed", "TEXT", 20),
    ("length_m", "DOUBLE", None),
]
TAGS = ("highway", "ref", "name", "oneway", "bridge", "layer", "maxspeed")


def read_ways(paths, bbox=None, keep=None):
    # Yields (osm_id, tags, [(node_id, lon, lat), ...]) for highway ways passing keep(tags), touching bbox.
    # .pbf: pyosmium when installed, else the stdlib/numpy reader below (Pro env has no osmium).
    for path in paths:
        t0 = time.perf_counter()
        if not path.endswith(".pbf"):
            raise ValueError(f"unsupported OSM format: {path}")
        try:
            import osmium
            reader = _ways_osmium(osmium, path)
        except ImportError:
            reader = _ways_pbf(path, keep)
        n = 0
        for osm_id, tags, nodes in reader:
            if len(nodes) < 2 or (keep and not keep(tags)):
                continue
            if bbox and not any(bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3] for _, x, y in nodes):
                continue
            n += 1
            yield osm_id, tags, nodes
        print(f"{os.path.basename(path)}: {n} ways in {time.perf_counter() - t0:.0f} s")


def _ways_osmium(osmium, path):
    fp = osmium.FileProcessor(path).with_locations().with_filter(osmium.filter.KeyFilter("highway"))
    for obj in fp:
        if obj.is_way():
            yield obj.id, dict(obj.tags), [(n.ref, n.lon, n.lat) for n in obj.nodes if n.location.valid()]


# ---- stdlib + numpy PBF reader: two passes, ways first, then only the nodes they need ----

def _varint(buf, pos):
    result = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if b < 0x80:
            return result, pos
        shift += 7


def _fields(buf):
    # Protobuf wire format: yields (field number, value); length-delimited values as memoryview.
    pos, n = 0, len(buf)
    while pos < n:
        key, pos = _varint(buf, pos)
        wt = key & 7
        if wt == 0:
            val, pos = _varint(buf, pos)
        elif wt == 2:
            ln, pos = _varint(buf, pos)
            val, pos = buf[pos:pos + ln], pos + ln
        elif wt == 1:
            val, pos = buf[pos:pos + 8], pos + 8
        elif wt == 5:
            val, pos = buf[pos:pos + 4], pos + 4
        else:
            raise ValueError(f"unsupported wire type {wt}")
        yield key >> 3, val


def _np_varints(buf):
    a = np.frombuffer(buf, dtype=np.uint8)
    ends = np.flatnonzero(a < 0x80)
    if not len(ends):
        return np.zeros(0, dtype=np.uint64)
    starts = np.empty_like(ends)
    starts[0], starts[1:] = 0, ends[:-1] + 1
    lens = ends - starts + 1
    out = np.zeros(len(ends), dtype=np.uint64)
    for k in range(int(lens.max())):
        m = lens > k
        out[m] |= (a[starts[m] + k] & 0x7F).astype(np.uint64) << np.uint64(7 * k)
    return out


def _np_sint_delta(buf):
    u = _np_varints(buf)
    return np.cumsum((u >> np.uint64(1)).astype(np.int64) ^ -(u & np.uint64(1)).astype(np.int64))


def _py_uints(buf):
    out, pos = [], 0
    while pos < len(buf):
        v, pos = _varint(buf, pos)
        out.append(v)
    return out


def _blocks(path):
    # Decompressed OSMData PrimitiveBlocks.
    with open(path, "rb") as f:
        while True:
            head = f.read(4)
            if len(head) < 4:
                return
            header = dict(_fields(memoryview(f.read(struct.unpack(">I", head)[0]))))
            blob = dict(_fields(memoryview(f.read(header[3]))))
            if bytes(header[1]) != b"OSMData":
                continue
            if 1 in blob:
                yield memoryview(bytes(blob[1]))
            elif 3 in blob:
                yield memoryview(zlib.decompress(blob[3]))
            else:
                raise ValueError("PBF blob compression other than zlib is not supported")


def _block_parts(block):
    strings, groups, gran, lat_off, lon_off = [], [], 100, 0, 0
    for fn, val in _fields(block):
        if fn == 1:
            strings = [bytes(v).decode("utf-8") for f2, v in _fields(val) if f2 == 1]
        elif fn == 2:
            groups.append(val)
        elif fn == 17:
            gran = val
        elif fn == 19:
            lat_off = val - (1 << 64) if val >= 1 << 63 else val
        elif fn == 20:
            lon_off = val - (1 << 64) if val >= 1 << 63 else val
    return strings, groups, gran, lat_off, lon_off


def _ways_pbf(path, keep):
    ways = []
    for block in _blocks(path):
        strings, groups, *_ = _block_parts(block)
        hw = strings.index("highway") if "highway" in strings else -1
        if hw < 0:
            continue
        for g in groups:
            for fn, way in _fields(g):
                if fn != 3:
                    continue
                wid, keys, vals, refs = 0, [], [], None
                for f2, v in _fields(way):
                    if f2 == 1:
                        wid = v
                    elif f2 == 2:
                        keys = _py_uints(v)
                    elif f2 == 3:
                        vals = _py_uints(v)
                    elif f2 == 8:
                        refs = v
                if hw not in keys or refs is None:
                    continue
                tags = {strings[k]: strings[x] for k, x in zip(keys, vals)}
                if keep and not keep(tags):
                    continue
                ways.append((wid, tags, _np_sint_delta(refs)))
    if not ways:
        return
    needed = np.unique(np.concatenate([w[2] for w in ways]))
    lon = np.full(len(needed), np.nan)
    lat = np.full(len(needed), np.nan)
    for block in _blocks(path):
        strings, groups, gran, lat_off, lon_off = _block_parts(block)
        for g in groups:
            for fn, dense in _fields(g):
                if fn == 1:
                    raise ValueError("non-dense nodes in PBF are not supported")
                if fn != 2:
                    continue
                parts = dict((f2, v) for f2, v in _fields(dense) if f2 in (1, 8, 9))
                ids = _np_sint_delta(parts[1])
                idx = np.minimum(np.searchsorted(needed, ids), len(needed) - 1)
                hit = needed[idx] == ids
                if hit.any():
                    lat[idx[hit]] = 1e-9 * (lat_off + gran * _np_sint_delta(parts[8])[hit])
                    lon[idx[hit]] = 1e-9 * (lon_off + gran * _np_sint_delta(parts[9])[hit])
    for wid, tags, refs in ways:
        i = np.searchsorted(needed, refs)
        ok = ~np.isnan(lon[i])
        yield wid, tags, list(zip(refs[ok].tolist(), lon[i][ok].tolist(), lat[i][ok].tolist()))


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
            cur.insertRow([line] + [str(e[n]) if n in ("osm_id", "u", "v") else e[n] for n in names])
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

    # Border ways appear in both state extracts: keep the first copy.
    ways, seen = [], set()
    for w in read_ways(pbfs, bbox, lambda tags: keep_way(tags, cfg)):
        if w[0] not in seen:
            seen.add(w[0])
            ways.append(w)
    print(f"ways after cross-state dedupe: {len(ways)}")
    _, _, bad, share = build_from_ways(ways, cfg, out_fc, pkl, scratch, keep, study_area)
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
