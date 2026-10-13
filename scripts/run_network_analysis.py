# Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\run_network_analysis.py
import os
import pickle
import sys
from collections import defaultdict, deque

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

M_PER_MI = 1609.344
FORWARD = {"yes", "true", "1"}
FACILITY_LAYERS = [
    "Criticality_Inputs/hospitals", "Criticality_Inputs/fire_ems_stations", "Criticality_Inputs/police_stations",
    "Criticality_Inputs/emergency_operations_centers", "Criticality_Inputs/cooling_warming_centers",
    "Criticality_Inputs/schools", "Criticality_Inputs/libraries",
]


def scenario_name(s):
    return f"rp{s['return_period']}_{s['year']}" + (f"_{s['ssp']}" if s["year"] != "cur" else "")


def depth_column(s):
    return f"flood_depth_ft_{scenario_name(s)}"


def directed(g, closed=frozenset()):
    import networkx as nx
    dg = nx.MultiDiGraph()
    dg.add_nodes_from(g.nodes(data=True))
    for _, _, k, d in g.edges(keys=True, data=True):
        if k in closed:
            continue
        u, v = d["u"], d["v"]  # digitized direction; MultiGraph iteration order is not
        ow = (d.get("oneway") or "").lower()
        if ow != "-1":
            dg.add_edge(u, v, key=k, length_m=d["length_m"])
        if ow not in FORWARD:
            dg.add_edge(v, u, key=k, length_m=d["length_m"])
    return dg


def open_undirected(g, closed):
    import networkx as nx
    h = nx.MultiGraph()
    h.add_nodes_from(g.nodes)
    h.add_edges_from((u, v, k, d) for u, v, k, d in g.edges(keys=True, data=True) if k not in closed)
    return h


def component_length(h, nodes):
    return sum(d["length_m"] for _, _, d in h.subgraph(nodes).edges(data=True))


def stranded_zones(h):
    # Main network = largest open component by length; every other component with edges is stranded.
    import networkx as nx
    comps = [c for c in nx.connected_components(h) if h.subgraph(c).number_of_edges()]
    if not comps:
        return set(), []
    comps.sort(key=lambda c: component_length(h, c), reverse=True)
    return comps[0], comps[1:]


def simple_bridges(h):
    # Bridges of a multigraph: parallel edges are never bridges.
    import networkx as nx
    simple = nx.Graph(h)
    mult = defaultdict(int)
    for u, v in h.edges():
        mult[frozenset((u, v))] += 1
    return {frozenset(e) for e in nx.bridges(simple) if mult[frozenset(e)] == 1}


def side_of(h, cut, start):
    # Nodes reachable from start without crossing the cut edge.
    seen, q = {start}, deque([start])
    while q:
        n = q.popleft()
        for m in h.neighbors(n):
            if m not in seen and frozenset((n, m)) != cut:
                seen.add(m)
                q.append(m)
    return seen


def egress_count(g, nodes):
    # Baseline edges with exactly one end in the zone.
    return sum(1 for x, y in g.edges(nbunch=nodes) if (x in nodes) != (y in nodes))


def single_egress_zones(g, h, main):
    # Areas of the main network that the scenario leaves hanging on one surviving edge
    # but that had more than one way out at baseline.
    base_bridges = simple_bridges(g)
    zones = []
    main_len = component_length(h, main)
    for cut in simple_bridges(h.subgraph(main)) - base_bridges:
        u, v = tuple(cut)
        a = side_of(h.subgraph(main), cut, u)
        side = a if component_length(h, a) <= main_len / 2 else main - a
        zones.append((side, egress_count(g, side)))
    zones.sort(key=lambda z: len(z[0]), reverse=True)
    kept = []
    for side, eb in zones:
        if not any(side <= k[0] for k in kept):
            kept.append((side, eb))
    return kept


def detours(g, dg_open, closed):
    # Alternative path between the ends of each closed edge, in its travel direction.
    import networkx as nx
    out = {}
    for _, _, k, d in g.edges(keys=True, data=True):
        if k not in closed:
            continue
        s, t = (d["v"], d["u"]) if (d.get("oneway") or "") == "-1" else (d["u"], d["v"])
        try:
            length, path = nx.bidirectional_dijkstra(dg_open, s, t, weight="length_m")
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            out[k] = (None, [])
            continue
        keys = [min(dg_open[a][b].items(), key=lambda kv: kv[1]["length_m"])[0] for a, b in zip(path, path[1:])]
        out[k] = (length / M_PER_MI, keys)
    return out


def centrality(g, k, seed):
    import networkx as nx
    dg = directed(g)
    n = dg.number_of_nodes()
    bc = nx.edge_betweenness_centrality(dg, k=min(k, n) if n else None, weight="length_m", seed=seed)
    out = defaultdict(float)
    for (_, _, key), val in bc.items():
        out[key] = max(out[key], val)
    return dict(out)


def zone_profile(edge_ids, edge_len, edge_tract, tract_len, tracts, facility_edges):
    # Tract values allocated by the zone's share of the tract's road length.
    pop = jobs = elderly = child = mobility = 0.0
    by_tract = defaultdict(float)
    for e in edge_ids:
        if edge_tract.get(e):
            by_tract[edge_tract[e]] += edge_len[e]
    for t, length in by_tract.items():
        a = tracts.get(t, {})
        share = length / tract_len[t] if tract_len.get(t) else 0.0
        p = (a.get("population") or 0) * share
        pop += p
        jobs += (a.get("jobs") or 0) * share
        elderly += p * (a.get("elderly_share") or 0)
        child += p * (a.get("child_share") or 0)
        mobility += p * (a.get("mobility_disab_pct") or 0) / 100
    ids = set(edge_ids)
    return {
        "population": round(pop, 1), "jobs": round(jobs, 1),
        "facilities": sum(1 for e in facility_edges.values() if e in ids),
        "elderly_share": elderly / pop if pop else None, "child_share": child / pop if pop else None,
        "mobility_disab_share": mobility / pop if pop else None,
    }


def analyze_scenario(g, closed, edge_tract=None, tract_len=None, tracts=None, facility_edges=None):
    edge_len = {k: d["length_m"] for _, _, k, d in g.edges(keys=True, data=True)}
    h = open_undirected(g, closed)
    main, comps = stranded_zones(h)
    zones = []
    for nodes in comps:
        zones.append(("stranded", nodes, None))
    for nodes, eb in single_egress_zones(g, h, main):
        zones.append(("single_egress", nodes, eb))
    edge_zone, zone_rows = {}, []
    for i, (ztype, nodes, eb) in enumerate(zones, 1):
        eids = [k for _, _, k in h.subgraph(nodes).edges(keys=True)]
        if eb is None:
            eb = egress_count(g, nodes)
        for e in eids:
            edge_zone.setdefault(e, i)
        row = {"zone_id": i, "zone_type": ztype, "egress_baseline": eb,
               "egress_scenario": 0 if ztype == "stranded" else 1, "single_egress": int(ztype == "single_egress"),
               "miles": sum(edge_len[e] for e in eids) / M_PER_MI, "edge_ids": eids}
        row.update(zone_profile(eids, edge_len, edge_tract or {}, tract_len or {}, tracts or {}, facility_edges or {}))
        zone_rows.append(row)
    det = detours(g, directed(g, closed), closed)
    edges = {}
    for k in edge_len:
        z = edge_zone.get(k)
        stranded = z is not None and zone_rows[z - 1]["zone_type"] == "stranded"
        edges[k] = {"closed": int(k in closed), "stranded": int(stranded and k not in closed),
                    "zone_id": z, "detour_mi": det.get(k, (None,))[0]}
    return edges, zone_rows, det


# ---- arcpy glue ----

def edge_depths(cfg, scenarios):
    import arcpy
    table = cfg["analysis"].get("edge_depth_table", "")
    path = common.repo_path(table) if table else ""
    if not path or not arcpy.Exists(path):
        raise RuntimeError(
            "No flood depths keyed on OSM edge_id. The ICF HAZ table is keyed on the old Tier 1 asset_id; "
            "set [analysis] edge_depth_table in config/build.toml to a table with edge_id and "
            + ", ".join(depth_column(s) for s in scenarios))
    cols = [depth_column(s) for s in scenarios]
    out = {c: {} for c in cols}
    for row in arcpy.da.SearchCursor(path, ["edge_id"] + cols):
        for c, v in zip(cols, row[1:]):
            out[c][row[0]] = v
    return out


def spatial_inputs(cfg, edges_fc, scratch, keep):
    # edge -> tract by midpoint, tract attributes, facility -> nearest edge. Computed once per run.
    import arcpy
    import csv
    src = common.repo_path(cfg["paths"]["source_gdb"])
    mids = os.path.join(scratch, "analysis_edge_midpoints")
    sr = arcpy.Describe(edges_fc).spatialReference
    common.write_rows(mids, [("edge_id", "TEXT", 40)],
                      ([shp.positionAlongLine(0.5, True), eid] for eid, shp in arcpy.da.SearchCursor(edges_fc, ["edge_id", "SHAPE@"])),
                      "POINT", sr)
    tract_fc = os.path.join(src, "Criticality_Inputs/population_forecast_tract")
    joined = os.path.join(scratch, "analysis_edge_tract")
    arcpy.analysis.SpatialJoin(mids, tract_fc, joined, "JOIN_ONE_TO_ONE", "KEEP_ALL", match_option="WITHIN")
    edge_tract = {e: t for e, t in arcpy.da.SearchCursor(joined, ["edge_id", "GeoID"])}
    tracts = {t: {"population": p, "jobs": j} for t, p, j in
              arcpy.da.SearchCursor(tract_fc, ["GeoID", "Population2020", "Employment2020"])}
    for t, m in arcpy.da.SearchCursor(os.path.join(src, "Adaptive_Capacity/cdc_places_health"), ["GeoID", "mobility_disab_pct"]):
        tracts.setdefault(t, {})["mobility_disab_pct"] = m
    acs = common.repo_path(cfg["inputs"]["acs_csv"])
    if os.path.exists(acs):
        with open(acs, newline="") as f:
            for r in csv.DictReader(f):
                tot = int(r["pop_total"])
                if tot:
                    a = tracts.setdefault(r["GeoID"], {})
                    a["elderly_share"] = int(r["pop_65plus"]) / tot
                    a["child_share"] = int(r["pop_under18"]) / tot
    facility_edges = {}
    for layer in FACILITY_LAYERS:
        out = os.path.join(scratch, "analysis_facility_edge")
        arcpy.analysis.SpatialJoin(os.path.join(src, layer), edges_fc, out, "JOIN_ONE_TO_ONE", "KEEP_ALL",
                                   match_option="CLOSEST", search_radius="500 Meters")
        for oid, eid in arcpy.da.SearchCursor(out, ["TARGET_FID", "edge_id"]):
            facility_edges[f"{layer}:{oid}"] = eid
    common.cleanup([mids, joined, os.path.join(scratch, "analysis_facility_edge")], keep)
    return edge_tract, tracts, facility_edges


def write_outputs(gdb, edges_fc, name, edges, zones, det):
    import arcpy
    sr = arcpy.Describe(edges_fc).spatialReference
    need = {e for z in zones for e in z["edge_ids"]} | {e for _, keys in det.values() for e in keys}
    shapes = {eid: shp for eid, shp in arcpy.da.SearchCursor(edges_fc, ["edge_id", "SHAPE@"]) if eid in need}

    def union(ids):
        parts = arcpy.Array()
        for e in ids:
            for part in shapes[e]:
                parts.add(part)
        return arcpy.Polyline(parts, sr)

    common.write_rows(os.path.join(gdb, f"edge_results_{name}"),
                      [("edge_id", "TEXT", 40), ("closed", "SHORT", None), ("stranded", "SHORT", None),
                       ("zone_id", "LONG", None), ("detour_mi", "DOUBLE", None)],
                      ([k, r["closed"], r["stranded"], r["zone_id"], r["detour_mi"]] for k, r in edges.items()))
    zfields = [("zone_id", "LONG", None), ("zone_type", "TEXT", 16), ("egress_baseline", "LONG", None),
               ("egress_scenario", "LONG", None), ("single_egress", "SHORT", None), ("miles", "DOUBLE", None),
               ("population", "DOUBLE", None), ("jobs", "DOUBLE", None), ("facilities", "LONG", None),
               ("elderly_share", "DOUBLE", None), ("child_share", "DOUBLE", None),
               ("mobility_disab_share", "DOUBLE", None)]
    common.write_rows(os.path.join(gdb, f"stranded_zones_{name}"), zfields,
                      ([union(z["edge_ids"])] + [z[f[0]] for f in zfields] for z in zones if z["edge_ids"]),
                      "POLYLINE", sr)
    common.write_rows(os.path.join(gdb, f"detours_{name}"),
                      [("closed_edge_id", "TEXT", 40), ("detour_mi", "DOUBLE", None), ("path_edges", "LONG", None)],
                      ([union(keys), k, mi, len(keys)] for k, (mi, keys) in det.items() if keys), "POLYLINE", sr)


def run(cfg=None):
    cfg = cfg or common.load_config()
    a = cfg["analysis"]
    scratch, keep = common.setup_scratch(cfg)
    gdb = common.repo_path(cfg["paths"]["build_gdb"])
    edges_fc = os.path.join(gdb, "osm_edges")
    with open(common.repo_path(cfg["paths"]["graph_pickle"]), "rb") as f:
        g = pickle.load(f)
    depths = edge_depths(cfg, a["scenarios"])
    edge_tract, tracts, facility_edges = spatial_inputs(cfg, edges_fc, scratch, keep)
    tract_len = defaultdict(float)
    for _, _, k, d in g.edges(keys=True, data=True):
        if edge_tract.get(k):
            tract_len[edge_tract[k]] += d["length_m"]

    cent = centrality(g, a["centrality_k"], a["seed"])
    common.write_rows(os.path.join(gdb, "edge_centrality"), [("edge_id", "TEXT", 40), ("centrality", "DOUBLE", None)],
                      ([k, v] for k, v in cent.items()))
    for s in a["scenarios"]:
        name = scenario_name(s)
        col = depths[depth_column(s)]
        closed = frozenset(k for k, v in col.items() if v is not None and v > a["depth_threshold_ft"])
        edges, zones, det = analyze_scenario(g, closed, edge_tract, tract_len, tracts, facility_edges)
        write_outputs(gdb, edges_fc, name, edges, zones, det)
        n_str = sum(1 for z in zones if z["zone_type"] == "stranded")
        print(f"{name}: closed {len(closed)} edges, {n_str} stranded zones, "
              f"{len(zones) - n_str} single-egress zones")
        common.write_metadata(
            os.path.join(gdb, f"stranded_zones_{name}"), f"Stranded zones, {name}",
            "Dated snapshot: OSM edges with Fathom depth above threshold closed; zones cut off (stranded) or left "
            "on one surviving edge (single egress). Detour length is the Phase 2 proxy for disruption impact.",
            ["osm_edges", "Fathom depths (project only)", "MARC Forecast2050 tracts", "CDC PLACES", "ACS 2024 5-year B01001"],
            {"depth_threshold_ft": a["depth_threshold_ft"], **s}, [f"edge_results_{name}", f"detours_{name}"],
            "run_network_analysis.py")


if __name__ == "__main__":
    run()
