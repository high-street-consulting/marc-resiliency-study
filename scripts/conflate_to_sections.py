# Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\conflate_to_sections.py
import csv
import os
import re
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
import lrs

RID = "route_id"
KDOT_PREFIX = {"I": "1", "U": "2", "K": "3"}
KEYID = re.compile(r"^20(\d{3})([IUK])(\d{5})(\d)(\d)-(NB|SB|EB|WB)([\d.]+)$")
NUM = re.compile(r"^\d+(\.\d+)?$")


def load_rules(path=None):
    path = path or os.path.join(common.REPO, "config", "conflation_rules.csv")
    with open(path, newline="") as f:
        return [r for r in csv.DictReader(f) if r["enabled"] == "1"]


def kdot_route(county, prefix, number, suffix, direction):
    # KS HPMS Route_ID: county(3) prefix(1) number(5) suffix(1) non-inventory flag(1) 00000.
    return f"{county}{KDOT_PREFIX[prefix]}{number}{suffix}{direction}00000"


def split_measures(s, length_mi):
    # "15.815.9" -> (15.8, 15.9): the two mileposts are concatenated; pick the split whose span fits the length.
    best = None
    for i in range(1, len(s)):
        a, b = s[:i], s[i:]
        if not (NUM.match(a) and NUM.match(b)) or b.startswith("."):
            continue
        fa, fb = float(a), float(b)
        if fb <= fa or fb - fa > 1.0:
            continue
        err = abs((fb - fa) - length_mi)
        if best is None or err < best[0]:
            best = (err, fa, fb)
    return best[1:] if best else None


def parse_keyid(key, length_mi):
    m = KEYID.match(key or "")
    if not m:
        return None
    county, prefix, number, suffix, inv, direction, meas = m.groups()
    ms = split_measures(meas, length_mi)
    if not ms:
        return None
    non_inv = "1" if direction in ("SB", "WB") else inv
    return kdot_route(county, prefix, number, suffix, non_inv), ms[0], ms[1]


def nhfn_route(rid):
    return rid + "00000" if rid and len(rid) == 11 else rid


def value_of(row_vals, rule):
    fields = rule["value_field"].split(";")
    if len(fields) == 1:
        v = row_vals[0]
        return None if v in ("", None) else v
    nums = [int(v) for v in row_vals if v not in (None, "", "N") and str(v).isdigit()]
    return min(nums) if nums else None


def source_path(src_gdb, rule):
    return os.path.join(src_gdb, rule["layer"])


def events_lrs(src, rule, routes):
    import arcpy
    fields = [rule["route_field"], rule["from_field"], rule["to_field"]] + rule["value_field"].split(";")
    out, n = [], 0
    for r in arcpy.da.SearchCursor(src, fields):
        n += 1
        rid = nhfn_route(r[0]) if rule["rule_id"] == "nhfn" else r[0]
        if rid in routes:
            out.append((rid, r[1], r[2], {rule["attr"]: value_of(r[3:], rule)}))
    return out, n


def events_keyid(src, rule, routes, mpu):
    import arcpy
    out, n, unparsed, missing = [], 0, 0, Counter()
    for key, shp_len, *vals in arcpy.da.SearchCursor(src, [rule["route_field"], "SHAPE@LENGTH"] + rule["value_field"].split(";")):
        n += 1
        p = parse_keyid(key, shp_len * mpu / 1609.344)
        if not p:
            unparsed += 1
            continue
        if p[0] not in routes:
            missing[p[0]] += 1
            continue
        out.append((p[0], p[1], p[2], {rule["attr"]: value_of(vals, rule)}))
    print(f"  KEYID_1: {n} rows, {unparsed} unparsed, {sum(missing.values())} on routes not in HPMS "
          f"(e.g. {list(missing)[:3]})")
    return out, n


def locate_points(points, routes_fc, sr, scratch, radius_m, name):
    # points: [(key, PointGeometry)] -> {key: [(rid, meas, dist_m)]}
    import arcpy
    fc = os.path.join(scratch, f"conflate_{name}_points")
    common.write_rows(fc, [("pkey", "TEXT", 80)], ([g, k] for k, g in points), "POINT", sr)
    tbl = os.path.join(scratch, f"conflate_{name}_locations")
    arcpy.lr.LocateFeaturesAlongRoutes(fc, routes_fc, RID, f"{radius_m} Meters", tbl, f"{RID} POINT meas",
                                       "ALL", "DISTANCE", "ZERO", "FIELDS")
    found = defaultdict(list)
    for k, rid, m, d in arcpy.da.SearchCursor(tbl, ["pkey", RID, "meas", "Distance"]):
        found[k].append((rid, m, abs(d) * sr.metersPerUnit))
    return found, [fc, tbl]


def events_locate(src, rule, routes_fc, sr, scratch, radius_m):
    import arcpy
    feats, pts = {}, []
    for oid, rid, shp, *vals in arcpy.da.SearchCursor(src, ["OID@", rule["route_field"], "SHAPE@"] + rule["value_field"].split(";"),
                                                      spatial_reference=sr):
        feats[oid] = (rid, value_of(vals, rule))
        pts += [(f"{oid}:S", arcpy.PointGeometry(shp.firstPoint, sr)), (f"{oid}:E", arcpy.PointGeometry(shp.lastPoint, sr))]
    found, temps = locate_points(pts, routes_fc, sr, scratch, radius_m, rule["rule_id"])
    out = []
    for oid, (rid, val) in feats.items():
        s = [c for c in found.get(f"{oid}:S", []) if c[0] == rid]
        e = [c for c in found.get(f"{oid}:E", []) if c[0] == rid]
        if s and e:
            out.append((rid, min(s, key=lambda c: c[2])[1], min(e, key=lambda c: c[2])[1], {rule["attr"]: val}))
    return out, len(feats), temps


def events_nbi(src, rule, routes_fc, route_numbers, sr, scratch, radius_m):
    import arcpy
    fields = ["OID@", "SHAPE@", "STATE_CODE_001", "COUNTY_CODE_003", "ROUTE_PREFIX_005B", "ROUTE_NUMBER_005D"]
    feats, pts = {}, []
    for oid, shp, st, county, prefix, number, *vals in arcpy.da.SearchCursor(src, fields + rule["value_field"].split(";"),
                                                                            spatial_reference=sr):
        num = int(number) if (number or "").strip().isdigit() else None
        lrs_rid = None
        if st == "20" and prefix in ("1", "2", "3") and (county or "").isdigit() and num:
            lrs_rid = kdot_route(f"{(int(county) + 1) // 2:03d}", "IUK"[int(prefix) - 1], f"{num:05d}", "0", "0")
        feats[oid] = (lrs_rid, num, value_of(vals, rule))
        pts.append((str(oid), shp))
    found, temps = locate_points(pts, routes_fc, sr, scratch, radius_m, rule["rule_id"])
    out, how = [], Counter()
    for oid, (lrs_rid, num, val) in feats.items():
        cands = sorted(found.get(str(oid), []), key=lambda c: c[2])
        pick = next((c for c in cands if lrs_rid and c[0] == lrs_rid), None)
        method = "lrs_route"
        if not pick:
            pick, method = next((c for c in cands if num and route_numbers.get(c[0]) == num), None), "snap_number"
        if not pick and cands:
            pick, method = cands[0], "snap_nearest"
        if pick:
            how[method] += 1
            out.append((pick[0], pick[1], pick[1], {rule["attr"]: val}))
        else:
            how["unmatched"] += 1
    print(f"  NBI placement: {dict(how)}")
    return out, len(feats), temps


def dedupe_paired(src, sr):
    # Keys of features whose reversed twin was already seen (same endpoints, same length).
    import arcpy
    seen, drop = set(), set()
    for oid, shp in arcpy.da.SearchCursor(src, ["OID@", "SHAPE@"], spatial_reference=sr):
        ends = sorted([(round(shp.firstPoint.X), round(shp.firstPoint.Y)), (round(shp.lastPoint.X), round(shp.lastPoint.Y))])
        key = (tuple(ends), round(shp.length))
        if key in seen:
            drop.add(oid)
        seen.add(key)
    return drop


def section_sample_points(sections_fc, sr):
    # Three points per section at the centers of its thirds; each stands for a third of the section.
    import arcpy
    pts = []
    for aid, rid, b, e, shp in arcpy.da.SearchCursor(sections_fc, ["asset_id", RID, "begin_point", "end_point", "SHAPE@"]):
        for i, f in enumerate((1 / 6, 1 / 2, 5 / 6)):
            pts.append((f"{aid}|{i}", rid, b + (e - b) * i / 3, b + (e - b) * (i + 1) / 3, shp.positionAlongLine(f, True)))
    return pts


def events_spatial(src, rule, sample_pts, sr, scratch, radius_m, drop=frozenset()):
    import arcpy
    pts_fc = os.path.join(scratch, "conflate_section_points")
    if not arcpy.Exists(pts_fc):
        common.write_rows(pts_fc, [("pkey", "TEXT", 100)], ([g, k] for k, _, _, _, g in sample_pts), "POINT", sr)
    lyr = arcpy.management.MakeFeatureLayer(src, f"{rule['rule_id']}_lyr").getOutput(0)
    if drop:
        oid = arcpy.Describe(src).OIDFieldName
        keep_ids = [r[0] for r in arcpy.da.SearchCursor(src, ["OID@"]) if r[0] not in drop]
        arcpy.management.SelectLayerByAttribute(lyr, "NEW_SELECTION", f"{oid} IN ({','.join(map(str, keep_ids))})")
        print(f"  dropped {len(drop)} paired-direction duplicates")
    joined = os.path.join(scratch, f"conflate_{rule['rule_id']}_join")
    arcpy.analysis.SpatialJoin(pts_fc, lyr, joined, "JOIN_ONE_TO_ONE", "KEEP_COMMON",
                               match_option="CLOSEST", search_radius=f"{radius_m} Meters")
    arcpy.management.Delete(lyr)
    vf = rule["value_field"]
    vals = {k: v for k, v in arcpy.da.SearchCursor(joined, ["pkey", vf])}
    out = [(rid, b, e, {rule["attr"]: vals[k]}) for k, rid, b, e, _ in sample_pts if vals.get(k) not in (None, "")]
    return out, int(arcpy.management.GetCount(src)[0]), [joined]


def run(cfg=None):
    import arcpy
    cfg = cfg or common.load_config()
    c = cfg["conflation"]
    scratch, keep = common.setup_scratch(cfg)
    gdb = common.repo_path(cfg["paths"]["build_gdb"])
    src_gdb = common.repo_path(cfg["paths"]["source_gdb"])
    sections = os.path.join(gdb, "scored_sections")
    routes_fc = os.path.join(gdb, "hpms_routes")
    sr = arcpy.Describe(sections).spatialReference
    routes = {r[0]: r[1] for r in arcpy.da.SearchCursor(routes_fc, [RID, "route_number"])}
    targets = [(aid, rid, b, e) for aid, rid, b, e in arcpy.da.SearchCursor(sections, ["asset_id", RID, "begin_point", "end_point"])]
    sample_pts = None
    temps = [os.path.join(scratch, "conflate_section_points")]
    if arcpy.Exists(temps[0]):
        arcpy.management.Delete(temps[0])

    results, rules = defaultdict(dict), load_rules()
    for rule in rules:
        src = source_path(src_gdb, rule)
        key = rule["key"]
        if key == "lrs":
            evs, n = events_lrs(src, rule, routes)
        elif key == "kdot_keyid":
            evs, n = events_keyid(src, rule, routes, sr.metersPerUnit)
        elif key == "lrs_locate":
            evs, n, t = events_locate(src, rule, routes_fc, sr, scratch, c["locate_radius_m"])
            temps += t
        elif key == "nbi":
            evs, n, t = events_nbi(src, rule, routes_fc, routes, sr, scratch, c["locate_radius_m"])
            temps += t
        elif key in ("spatial", "spatial_dedupe"):
            sample_pts = sample_pts or section_sample_points(sections, sr)
            drop = dedupe_paired(src, sr) if key == "spatial_dedupe" else frozenset()
            evs, n, t = events_spatial(src, rule, sample_pts, sr, scratch, c["spatial_radius_m"], drop)
            temps += t
        else:
            raise ValueError(f"unknown key type {key!r} in rule {rule['rule_id']}")
        agg = lrs.aggregate(targets, evs, {rule["attr"]: rule["method"]})
        hit = sum(1 for v in agg.values() if v[rule["attr"]] is not None)
        print(f"{rule['rule_id']}: {n} source rows, {len(evs)} events on HPMS routes, {hit} of {len(targets)} sections")
        for aid, v in agg.items():
            results[aid].update(v)

    existing = {f.name for f in arcpy.ListFields(sections)}
    new_fields = []
    for rule in rules:
        text = rule["method"] == "majority" and rule["rule_id"] in ("kdot_pavement", "modot_pavement")
        for name, typ in ((rule["attr"], "TEXT" if text else "DOUBLE"), (f"cov_{rule['attr']}", "DOUBLE")):
            if name not in existing:
                arcpy.management.AddField(sections, name, typ, field_length=20 if typ == "TEXT" else None)
            new_fields.append(name)
    if "low_coverage" not in existing:
        arcpy.management.AddField(sections, "low_coverage", "TEXT", field_length=255)
    with arcpy.da.UpdateCursor(sections, ["asset_id"] + new_fields + ["low_coverage"]) as cur:
        for row in cur:
            r = results.get(row[0], {})
            row[1:-1] = [r.get(f) for f in new_fields]
            low = [rule["attr"] for rule in rules if 0 < (r.get(f"cov_{rule['attr']}") or 0) < c["low_coverage"]]
            row[-1] = ",".join(low) or None
            cur.updateRow(row)
    common.write_metadata(
        sections, "Scored network sections (scored_sections)",
        "Tier 1 HPMS sections with non-HPMS attributes attached by LRS measure overlap or, where the source has no "
        "LRS key, by nearest feature at three points per section.",
        [r["source"] for r in rules], {**c, "rules": ",".join(r["rule_id"] for r in rules)}, [sections],
        "conflate_to_sections.py")
    common.cleanup(temps, keep)
    return sections


if __name__ == "__main__":
    run()
