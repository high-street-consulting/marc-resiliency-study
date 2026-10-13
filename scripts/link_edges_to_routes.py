# Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\link_edges_to_routes.py
import difflib
import math
import os
import re
import sys
from collections import defaultdict

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


def locate(edges, routes_fc, sr, scratch, max_radius_m):
    # LocateFeaturesAlongRoutes for edge start/end/mid points; returns {(edge_id, pt): [(rid, meas, dist_m)]}
    import arcpy
    pts = os.path.join(scratch, "link_edge_points")
    common.write_rows(pts, [("edge_id", "TEXT", 40), ("pt", "TEXT", 1)],
                      ([arcpy.PointGeometry(p, sr), eid, k] for eid, e in edges.items() for k, p in e["pts"].items()),
                      "POINT", sr)
    loc = os.path.join(scratch, "link_point_locations")
    arcpy.lr.LocateFeaturesAlongRoutes(pts, routes_fc, RID, f"{max_radius_m} Meters", loc,
                                       f"{RID} POINT meas", "ALL", "DISTANCE", "ZERO", "FIELDS")
    found = defaultdict(list)
    mpu = sr.metersPerUnit
    for eid, pt, rid, meas, dist in arcpy.da.SearchCursor(loc, ["edge_id", "pt", RID, "meas", "Distance"]):
        found[(eid, pt)].append((rid, meas, abs(dist) * mpu))
    return found, [pts, loc]


def route_angles(mid_events, routes_fc, scratch):
    # Tangent angle of each route (increasing-measure direction) at the given measures.
    import arcpy
    tbl = os.path.join(scratch, "link_mid_events")
    keys = list(mid_events)
    common.write_rows(tbl, [("k", "LONG", None), (RID, "TEXT", 32), ("meas", "DOUBLE", None)],
                      ([i, rid, m] for i, (rid, m) in enumerate(keys)))
    lyr = arcpy.lr.MakeRouteEventLayer(routes_fc, RID, tbl, f"{RID} POINT meas", "link_mid_lyr", None,
                                       "NO_ERROR_FIELD", "ANGLE_FIELD", "TANGENT", "ANGLE").getOutput(0)
    # TANGENT LOC_ANGLE points against increasing measure (east-running route reads 180); flip it.
    out = {keys[k]: (ang + 180) % 360 for k, ang in arcpy.da.SearchCursor(lyr, ["k", "LOC_ANGLE"])}
    arcpy.management.Delete(lyr)
    return out, [tbl]


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
                    with_m = t[1] >= s[1]
                    if e["oneway"] and ra.get("facility_type") in directional:
                        travel_with_m = with_m != e["reverse"]
                        if not travel_with_m or angle_diff(e["angle"], r_ang, 360) > lk["bearing_deg"]:
                            continue
                    elif angle_diff(e["angle"], r_ang, 180) > lk["bearing_deg"]:
                        continue
                    span = abs(t[1] - s[1])
                    span_ok = e["len_mi"] > 0 and abs(span - e["len_mi"]) / e["len_mi"] <= lk["span_tolerance"]
                    ref_ok = ra.get("number") in ref_numbers(e["ref"]) if ra.get("number") else False
                    name_sim = difflib.SequenceMatcher(None, norm_name(e["name"]), norm_name(ra.get("name"))).ratio() \
                        if e["name"] and ra.get("name") else 0.0
                    score = (span_ok, ref_ok, round(name_sim, 2), -angle_diff(e["angle"], r_ang, 180),
                             -(s[2] + t[2] + mid[2]))
                    if best is None or score > best[0]:
                        best = (score, rid, s[1], t[1])
        if best:
            (span_ok, ref_ok, name_sim, _, _), rid, m0, m1 = best
            method = "span" if span_ok else "radius"
            quality = "high" if span_ok and (ref_ok or name_sim >= 0.8) else "medium" if span_ok else "low"
            results[eid] = (rid, m0, m1, quality, method)
    return results


def link(edges_fc, routes_fc, events_table, cfg, scratch, keep):
    import arcpy
    lk = cfg["linkage"]
    sr = arcpy.Describe(edges_fc).spatialReference
    edges = edge_geometry(edges_fc, sr.metersPerUnit)
    found, temps = locate(edges, routes_fc, sr, scratch, max(lk["radius_m"].values()))
    mids = {(rid, m) for (eid, pt), cs in found.items() if pt == "M" for rid, m, _ in cs}
    angles, t2 = route_angles(mids, routes_fc, scratch)
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
    common.cleanup(temps + t2, keep)
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
