# Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\link_edges_to_routes.py
import difflib
import math
import os
import re
import sys
import time
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

RID = "route_id"
LINK_FIELDS = [("lrs_route_id", "TEXT", 32), ("lrs_from_m", "DOUBLE", None), ("lrs_to_m", "DOUBLE", None),
               ("lrs_match_quality", "TEXT", 8), ("lrs_match_method", "TEXT", 8)]
FORWARD = {"yes", "true", "1"}


def ref_numbers(ref):
    return {int(n) for n in re.findall(r"\d+", ref or "")}


def norm_name(s):
    return re.sub(r"[^A-Z0-9 ]", "", (s or "").upper()).strip()


def angle_diff(a, b, period):
    d = abs(a - b) % period
    return min(d, period - d)


def edge_geometry(edges_fc, mpu):
    # edge_id -> (start, end, mid, travel angle at mid in arithmetic degrees, length in miles, attrs)
    import arcpy
    out = {}
    fields = ["edge_id", "highway", "ref", "name", "oneway", "SHAPE@"]
    for eid, hw, ref, name, oneway, shp in arcpy.da.SearchCursor(edges_fc, fields):
        length = shp.length
        h = min(5.0 / mpu, length * 0.25)
        a = shp.positionAlongLine(length / 2 - h).firstPoint
        b = shp.positionAlongLine(length / 2 + h).firstPoint
        ang = math.degrees(math.atan2(b.Y - a.Y, b.X - a.X))
        if (oneway or "").lower() == "-1":
            ang = (ang + 180) % 360
        out[eid] = {
            "pts": {"S": shp.firstPoint, "E": shp.lastPoint, "M": shp.positionAlongLine(0.5, True).firstPoint},
            "angle": ang, "len_mi": length * mpu / 1609.344, "highway": hw or "", "ref": ref, "name": name,
            "oneway": (oneway or "").lower() in FORWARD or (oneway or "") == "-1",
            "reverse": (oneway or "") == "-1",
        }
    return out


def radius_for(highway, lk):
    base = highway.replace("_link", "")
    if highway in lk["freeway"] or base in lk["freeway"]:
        return lk["radius_m"]["freeway"]
    if highway in lk["arterial"] or base in lk["arterial"]:
        return lk["radius_m"]["arterial"]
    return lk["radius_m"]["other"]


def read_route_segments(routes_fc):
    # Route segments within parts: route ids, start/end x, y, m (route CRS units, miles for M).
    import arcpy
    rids, segs, nonmono = [], [], 0
    for rid, shp in arcpy.da.SearchCursor(routes_fc, [RID, "SHAPE@"]):
        r = len(rids)
        rids.append(rid)
        for part in shp:
            pts = np.array([(p.X, p.Y, p.M if p.M is not None else np.nan) for p in part if p is not None])
            if len(pts) < 2:
                continue
            nonmono += int(np.any(np.diff(pts[:, 2]) < -1e-6))
            segs.append(np.column_stack([np.full(len(pts) - 1, r), pts[:-1], pts[1:]]))
    segs = np.vstack(segs)
    segs = segs[~np.isnan(segs[:, [3, 6]]).any(axis=1)]
    if nonmono:
        print(f"  {nonmono} route parts with decreasing M")
    return rids, segs  # columns: route, x0, y0, m0, x1, y1, m1


def locate(edges, routes_fc, sr, max_radius_m, step_m=10.0):
    # cKDTree over route vertices densified to step_m; exact projection onto candidate segments.
    # Returns ({(edge_id, pt): [(rid, meas, dist_m)]}, {(rid, meas): bearing in increasing-M direction}).
    from scipy.spatial import cKDTree
    mpu = sr.metersPerUnit
    t0 = time.perf_counter()
    rids, segs = read_route_segments(routes_fc)
    t1 = time.perf_counter()
    dx, dy = segs[:, 4] - segs[:, 1], segs[:, 5] - segs[:, 2]
    seg_len = np.hypot(dx, dy)
    n = np.maximum(1, np.ceil(seg_len * mpu / step_m)).astype(np.int64)
    seg_of = np.repeat(np.arange(len(segs)), n)
    frac = (np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)) / np.repeat(n, n)
    tree = cKDTree(np.column_stack([segs[seg_of, 1] + frac * dx[seg_of], segs[seg_of, 2] + frac * dy[seg_of]]))
    t2 = time.perf_counter()

    keys = [(eid, k) for eid, e in edges.items() for k in "SEM"]
    pts = np.array([(edges[eid]["pts"][k].X, edges[eid]["pts"][k].Y) for eid, k in keys])
    hits = tree.query_ball_point(pts, r=(max_radius_m + step_m) / mpu)
    counts = np.fromiter((len(h) for h in hits), dtype=np.int64, count=len(hits))
    p_idx = np.repeat(np.arange(len(keys)), counts)
    s_idx = seg_of[np.fromiter((i for h in hits for i in h), dtype=np.int64, count=int(counts.sum()))]
    pair = np.unique(p_idx * len(segs) + s_idx)
    p_idx, s_idx = pair // len(segs), pair % len(segs)
    px, py = pts[p_idx, 0], pts[p_idx, 1]
    sdx, sdy, L2 = dx[s_idx], dy[s_idx], np.maximum(seg_len[s_idx] ** 2, 1e-12)
    t = np.clip(((px - segs[s_idx, 1]) * sdx + (py - segs[s_idx, 2]) * sdy) / L2, 0, 1)
    dist = np.hypot(segs[s_idx, 1] + t * sdx - px, segs[s_idx, 2] + t * sdy - py) * mpu
    meas = segs[s_idx, 3] + t * (segs[s_idx, 6] - segs[s_idx, 3])
    route = segs[s_idx, 0].astype(np.int64)
    ang = np.degrees(np.arctan2(sdy, sdx)) + np.where(segs[s_idx, 6] < segs[s_idx, 3], 180.0, 0.0)
    ok = dist <= max_radius_m
    p_idx, route, dist, meas, ang = p_idx[ok], route[ok], dist[ok], meas[ok], ang[ok] % 360
    order = np.lexsort((dist, route, p_idx))
    p_idx, route, dist, meas, ang = p_idx[order], route[order], dist[order], meas[order], ang[order]
    first = np.ones(len(p_idx), dtype=bool)
    first[1:] = (p_idx[1:] != p_idx[:-1]) | (route[1:] != route[:-1])
    found, angles = defaultdict(list), {}
    for i, r, d, m, a in zip(p_idx[first].tolist(), route[first].tolist(), dist[first].tolist(),
                             meas[first].tolist(), ang[first].tolist()):
        found[keys[i]].append((rids[r], m, d))
        angles[(rids[r], m)] = a
    print(f"locate: read {t1 - t0:.1f} s ({len(segs)} segments), tree {t2 - t1:.1f} s "
          f"({len(seg_of)} samples), query {time.perf_counter() - t2:.1f} s ({len(keys)} points)")
    return found, angles


def route_attrs(routes_fc):
    import arcpy
    return {r[0]: {"number": r[1], "facility_type": r[2], "name": r[3]}
            for r in arcpy.da.SearchCursor(routes_fc, [RID, "route_number", "facility_type", "route_name"])}


def match(edges, found, angles, rattrs, lk, ramp_ft):
    # Returns {edge_id: (route_id, from_m, to_m, quality, method)} for matched edges.
    results = {}
    directional = set(lk["directional_facility_types"])
    for eid, e in edges.items():
        r_max = radius_for(e["highway"], lk)
        is_ramp = e["highway"].endswith("_link")
        near = {k: [c for c in found.get((eid, k), []) if c[2] <= r_max] for k in "SEM"}
        best = None
        for rid in {c[0] for c in near["S"]} & {c[0] for c in near["E"]}:
            ra = rattrs.get(rid, {})
            if is_ramp != (ra.get("facility_type") == ramp_ft):
                continue
            mids = [c for c in near["M"] if c[0] == rid]
            if not mids:
                continue
            mid = min(mids, key=lambda c: c[2])
            r_ang = angles.get((rid, mid[1]))
            if r_ang is None:
                continue
            for s in (c for c in near["S"] if c[0] == rid):
                for t in (c for c in near["E"] if c[0] == rid):
                    if angle_diff(e["angle"], r_ang, 180) > lk["bearing_deg"]:
                        continue
                    # One-way edge on a directional route: prefer travel with increasing measure. Not required:
                    # some non-inventory routes (Facility_Type 6, e.g. KS I-435) are measured against travel.
                    dir_ok = not (e["oneway"] and ra.get("facility_type") in directional) or                         ((t[1] >= s[1]) != e["reverse"])
                    span = abs(t[1] - s[1])
                    span_ok = e["len_mi"] > 0 and abs(span - e["len_mi"]) / e["len_mi"] <= lk["span_tolerance"]
                    ref_ok = ra.get("number") in ref_numbers(e["ref"]) if ra.get("number") else False
                    name_sim = difflib.SequenceMatcher(None, norm_name(e["name"]), norm_name(ra.get("name"))).ratio() \
                        if e["name"] and ra.get("name") else 0.0
                    score = (span_ok, ref_ok, round(name_sim, 2), dir_ok, -angle_diff(e["angle"], r_ang, 180),
                             -(s[2] + t[2] + mid[2]))
                    if best is None or score > best[0]:
                        best = (score, rid, s[1], t[1])
        if best:
            (span_ok, ref_ok, name_sim, *_), rid, m0, m1 = best
            method = "span" if span_ok else "radius"
            quality = "high" if span_ok and (ref_ok or name_sim >= 0.8) else "medium" if span_ok else "low"
            results[eid] = (rid, m0, m1, quality, method)
    return results


def link(edges_fc, routes_fc, events_table, cfg, scratch, keep):
    import arcpy
    lk = cfg["linkage"]
    sr = arcpy.Describe(edges_fc).spatialReference
    edges = edge_geometry(edges_fc, sr.metersPerUnit)
    found, angles = locate(edges, routes_fc, sr, max(lk["radius_m"].values()))
    results = match(edges, found, angles, route_attrs(routes_fc), lk, cfg["hpms"]["ramp_facility_type"])

    existing = {f.name for f in arcpy.ListFields(edges_fc)}
    for name, typ, length in LINK_FIELDS:
        if name not in existing:
            arcpy.management.AddField(edges_fc, name, typ, field_length=length)
    with arcpy.da.UpdateCursor(edges_fc, ["edge_id"] + [f[0] for f in LINK_FIELDS]) as cur:
        for row in cur:
            row[1:] = list(results.get(row[0], (None,) * 5))
            cur.updateRow(row)
    common.write_rows(events_table, [("edge_id", "TEXT", 40), (RID, "TEXT", 32), ("from_m", "DOUBLE", None),
                                     ("to_m", "DOUBLE", None), ("with_measure", "SHORT", None),
                                     ("lrs_match_quality", "TEXT", 8), ("lrs_match_method", "TEXT", 8)],
                      ([eid, rid, min(a, b), max(a, b), int(b >= a), q, m]
                       for eid, (rid, a, b, q, m) in results.items()))
    return edges, results


def coverage_report(edges, results, lk):
    # Share of length matched, freeway classes vs all, span vs radius-only.
    tot, fw = defaultdict(float), defaultdict(float)
    for eid, e in edges.items():
        method = results[eid][4] if eid in results else "none"
        tot[method] += e["len_mi"]
        if e["highway"] in lk["freeway"] and not e["highway"].endswith("_link"):
            fw[method] += e["len_mi"]
    for label, d in (("all edges", tot), ("interstates/freeways", fw)):
        total = sum(d.values()) or 1.0
        print(f"{label}: {sum(d.values()):.1f} mi; span {d['span'] / total:.1%}, radius-only "
              f"{d['radius'] / total:.1%}, unmatched {d['none'] / total:.1%}")


def run(cfg=None):
    cfg = cfg or common.load_config()
    scratch, keep = common.setup_scratch(cfg)
    gdb = common.repo_path(cfg["paths"]["build_gdb"])
    edges_fc, routes_fc = os.path.join(gdb, "osm_edges"), os.path.join(gdb, "hpms_routes")
    events = os.path.join(gdb, "edge_lrs_events")
    edges, results = link(edges_fc, routes_fc, events, cfg, scratch, keep)
    coverage_report(edges, results, cfg["linkage"])
    lk = cfg["linkage"]
    common.write_metadata(
        events, "OSM edge to HPMS route linkage (edge_lrs_events)",
        "One row per matched OSM edge: HPMS route and measure span. OSM results flow to HPMS sections through it.",
        ["osm_edges", "hpms_routes"],
        {"radius_m": lk["radius_m"], "bearing_deg": lk["bearing_deg"], "span_tolerance": lk["span_tolerance"],
         "directional_facility_types": lk["directional_facility_types"]},
        [edges_fc, events], "link_edges_to_routes.py")
    return events


if __name__ == "__main__":
    run()
