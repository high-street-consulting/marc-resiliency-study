# Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\build_hpms_network.py
import csv
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
import lrs

RID, FROM, TO = "route_id", "begin_point", "end_point"
EVENT_PROPS = f"{RID} LINE {FROM} {TO}"
TOL = 1e-6
SOURCE = "FHWA HPMS 2024 public release (geo.dot.gov HPMS_FULL_<ST>_2024)"


def segmentation_items(path=None):
    path = path or os.path.join(common.REPO, "config", "segmentation_items.csv")
    with open(path, newline="") as f:
        return [r["field"] for r in csv.DictReader(f)]


def read_sections(fc, fields):
    import arcpy
    return list(arcpy.da.SearchCursor(fc, [RID, FROM, TO] + fields, f"{RID} IS NOT NULL"))


def event_rows(sections, col):
    # Dissolve consecutive same-value sections into one event; nulls are absent events.
    out = []
    by_route = defaultdict(list)
    for r in sections:
        if r[col] is not None:
            by_route[r[0]].append((r[1], r[2], r[col]))
    for rid, evs in by_route.items():
        evs.sort()
        cur = list(evs[0])
        for b, e, v in evs[1:]:
            if v == cur[2] and abs(b - cur[1]) <= TOL:
                cur[1] = e
            else:
                out.append((rid, cur[0], cur[1], cur[2]))
                cur = [b, e, v]
        out.append((rid, cur[0], cur[1], cur[2]))
    return out


def route_qc(sections, route_lengths_mi, span_tol):
    # Gaps and overlaps between consecutive sections, and geometry length vs measure span.
    issues = []
    by_route = defaultdict(list)
    for r in sections:
        by_route[r[0]].append((r[1], r[2]))
    for rid, secs in by_route.items():
        secs.sort()
        for (b0, e0), (b1, e1) in zip(secs, secs[1:]):
            if b1 > e0 + TOL:
                issues.append((rid, "gap", e0, b1, ""))
            elif b1 < e0 - TOL:
                issues.append((rid, "overlap", b1, min(e0, e1), ""))
        span = max(e for _, e in secs) - min(b for b, _ in secs)
        geom = route_lengths_mi.get(rid)
        if geom is not None and span > 0 and abs(geom - span) / span > span_tol:
            issues.append((rid, "length_vs_span", min(b for b, _ in secs), max(e for _, e in secs),
                           f"geometry {geom:.3f} mi, span {span:.3f} mi"))
    return issues


def non_monotonic_routes(routes_fc):
    import arcpy
    bad = []
    for rid, shape in arcpy.da.SearchCursor(routes_fc, [RID, "SHAPE@"]):
        last = None
        for part in shape:
            for p in part:
                if p is None or p.M is None:
                    continue
                if last is not None and p.M < last - TOL:
                    bad.append(rid)
                    break
                last = p.M
            else:
                continue
            break
    return bad


def merge_remnants(rows, min_len):
    # rows: [route_id, from, to, {attrs}] for one route, sorted. Remnants under min_len join the longer
    # contiguous neighbor and take its attributes.
    # ponytail: rescans the route after each merge, O(n^2) per route; fine for HPMS route sizes.
    rows = [list(r) for r in rows]
    while True:
        cand = [(r[2] - r[1], i) for i, r in enumerate(rows) if r[2] - r[1] < min_len - TOL]
        merged = False
        for _, i in sorted(cand):
            r = rows[i]
            prev = rows[i - 1] if i > 0 and abs(rows[i - 1][2] - r[1]) <= TOL else None
            nxt = rows[i + 1] if i + 1 < len(rows) and abs(rows[i + 1][1] - r[2]) <= TOL else None
            if not prev and not nxt:
                continue
            if nxt is None or (prev is not None and prev[2] - prev[1] >= nxt[2] - nxt[1]):
                prev[2] = r[2]
            else:
                nxt[1] = r[1]
            del rows[i]
            merged = True
            break
        if not merged:
            return rows


def is_tier1(a, h):
    f, nhs, ft = a.get("f_system"), a.get("nhs"), a.get("facility_type")
    return (f is not None and 1 <= f <= h["tier1_f_system_max"]) or (nhs or 0) > 0 or ft == h["ramp_facility_type"]


def asset_id(rid, b, e):
    return f"{rid}_{b:.3f}_{e:.3f}"


def study_area_events(study_area, routes_fc, scratch):
    # Route spans inside the study area, dissolved across internal county lines.
    import arcpy
    loc = os.path.join(scratch, "study_area_locations")
    arcpy.lr.LocateFeaturesAlongRoutes(study_area, routes_fc, RID, "0 Meters", loc, EVENT_PROPS)
    rows = [(rid, min(b, e), max(b, e), 1) for rid, b, e in arcpy.da.SearchCursor(loc, [RID, FROM, TO])]
    out = os.path.join(scratch, "ev_in_area")
    common.write_rows(out, [(RID, "TEXT", 32), (FROM, "DOUBLE", None), (TO, "DOUBLE", None), ("in_area", "SHORT", None)],
                      event_rows(rows, 3))
    arcpy.management.Delete(loc)
    return out


def overlay_union(tables, scratch, keep):
    import arcpy
    cur, temps = tables[0], []
    props = EVENT_PROPS
    for i, t in enumerate(tables[1:], 1):
        out = os.path.join(scratch, f"seg_overlay_{i}")
        arcpy.lr.OverlayRouteEvents(cur, props, t, EVENT_PROPS, "UNION", out, EVENT_PROPS, "NO_ZERO", "FIELDS")
        temps.append(out)
        cur = out
    return cur, temps


def run(cfg=None):
    import arcpy
    cfg = cfg or common.load_config()
    h = cfg["hpms"]
    scratch, keep = common.setup_scratch(cfg)
    sr = common.spatial_ref(cfg)
    build_gdb = common.ensure_gdb(common.repo_path(cfg["paths"]["build_gdb"]))
    hpms_gdb = common.repo_path(cfg["inputs"]["hpms_gdb"])
    seg_items = segmentation_items()
    all_items = seg_items + [i for i in h["event_items"] if i not in seg_items]
    temps = []

    # Routes per state, merged.
    route_fcs, sections, state_of = [], [], {}
    for st, layer in cfg["inputs"]["hpms_layers"].items():
        src = os.path.join(hpms_gdb, layer)
        proj = os.path.join(scratch, f"hpms_{st}_projected")
        arcpy.management.Project(src, proj, sr)
        routes = os.path.join(scratch, f"hpms_{st}_routes")
        arcpy.lr.CreateRoutes(proj, RID, routes, "TWO_FIELDS", FROM, TO)
        temps += [proj, routes]
        route_fcs.append(routes)
        rows = read_sections(src, all_items + h["sample_items"] + ["routename"])
        clash = {r[0] for r in rows} & set(state_of)
        if clash:
            raise RuntimeError(f"route_id collision across states: {sorted(clash)[:5]}")
        state_of.update((r[0], st) for r in rows)
        sections += rows
        print(f"{st}: {len(rows)} sections")
    hpms_routes = os.path.join(build_gdb, "hpms_routes")
    arcpy.management.Merge(route_fcs, hpms_routes)
    arcpy.management.AddField(hpms_routes, "state", "TEXT", field_length=2)
    for f, t in (("route_number", "LONG"), ("route_signing", "SHORT"), ("facility_type", "SHORT"),
                 ("f_system", "SHORT"), ("length_mi", "DOUBLE"), ("route_name", "TEXT")):
        arcpy.management.AddField(hpms_routes, f, t, field_length=120 if t == "TEXT" else None)

    # Route-level majority attributes for linkage.
    col = {name: i + 3 for i, name in enumerate(all_items + h["sample_items"] + ["routename"])}
    spans = defaultdict(lambda: [float("inf"), float("-inf")])
    for r in sections:
        s = spans[r[0]]
        s[0], s[1] = min(s[0], r[1]), max(s[1], r[2])
    rattr = lrs.aggregate(
        [(rid, rid, b, e) for rid, (b, e) in spans.items()],
        [(r[0], r[1], r[2], {"routenumber": r[col["routenumber"]], "routesigning": r[col["routesigning"]],
                             "facility_type": r[col["facility_type"]], "f_system": r[col["f_system"]],
                             "routename": r[col["routename"]]})
         for r in sections],
        {"routenumber": "majority", "routesigning": "majority", "facility_type": "majority", "f_system": "majority",
         "routename": "majority"})
    lengths = {}
    with arcpy.da.UpdateCursor(hpms_routes, [RID, "state", "route_number", "route_signing", "facility_type",
                                             "f_system", "length_mi", "route_name", "SHAPE@LENGTH"]) as cur:
        for row in cur:
            a = rattr.get(row[0], {})
            row[1] = state_of.get(row[0])
            row[2:6] = [a.get("routenumber"), a.get("routesigning"), a.get("facility_type"), a.get("f_system")]
            row[7] = a.get("routename")
            row[6] = row[8] * sr.metersPerUnit / 1609.344
            lengths[row[0]] = row[6]
            cur.updateRow(row)

    # Validation.
    issues = route_qc(sections, lengths, h["span_tolerance"])
    issues += [(rid, "non_monotonic", None, None, "") for rid in non_monotonic_routes(hpms_routes)]
    common.write_rows(os.path.join(build_gdb, "hpms_route_qc"),
                      [(RID, "TEXT", 32), ("issue", "TEXT", 20), ("from_m", "DOUBLE", None),
                       ("to_m", "DOUBLE", None), ("detail", "TEXT", 100)], issues)
    counts = defaultdict(int)
    for i in issues:
        counts[i[1]] += 1
    print(f"routes: {len(lengths)}  QC issues: {dict(counts)}")

    # One event table per item.
    ev_tables = {}
    for item in all_items:
        t = os.path.join(build_gdb, f"ev_{item}")
        n = common.write_rows(t, [(RID, "TEXT", 32), (FROM, "DOUBLE", None), (TO, "DOUBLE", None),
                                  (item, "DOUBLE", None)], event_rows(sections, col[item]))
        ev_tables[item] = t
        print(f"ev_{item}: {n} events")

    # HPMS was downloaded for the study-area envelope: the nine-county extent is one more split driver,
    # so sections end at the study-area boundary.
    study_area = os.path.join(common.repo_path(cfg["paths"]["source_gdb"]), cfg["inputs"]["study_area"])
    in_area = study_area_events(study_area, hpms_routes, scratch)
    temps.append(in_area)

    # Scored segmentation: UNION overlay of split-driver items, remnant merge, Tier 1 filter.
    overlaid, overlay_temps = overlay_union([ev_tables[i] for i in seg_items] + [in_area], scratch, keep)
    temps += overlay_temps
    by_route = defaultdict(list)
    for r in arcpy.da.SearchCursor(overlaid, [RID, FROM, TO] + seg_items + ["in_area"]):
        # UNION writes 0 where an item has no event; 0 is not a valid code for any split driver.
        by_route[r[0]].append((r[0], r[1], r[2], {k: v or None for k, v in zip(seg_items + ["in_area"], r[3:])}))
    segs = []
    for rid, rows in by_route.items():
        rows.sort(key=lambda r: r[1])
        segs += [r for r in merge_remnants(rows, h["merge_min_mi"]) if r[3]["in_area"] and is_tier1(r[3], h)]

    samples = lrs.aggregate(
        [(asset_id(r[0], r[1], r[2]), r[0], r[1], r[2]) for r in segs],
        [(r[0], r[1], r[2], {s: r[col[s]] for s in h["sample_items"]}) for r in sections],
        {s: "mean" for s in h["sample_items"]})
    others = lrs.aggregate(
        [(asset_id(r[0], r[1], r[2]), r[0], r[1], r[2]) for r in segs],
        [(r[0], r[1], r[2], {i: r[col[i]] for i in h["event_items"]}) for r in sections],
        {i: "majority" for i in h["event_items"]})
    fields = ([("asset_id", "TEXT", 60), (RID, "TEXT", 32), ("state", "TEXT", 2), (FROM, "DOUBLE", None),
               (TO, "DOUBLE", None), ("length_mi", "DOUBLE", None)]
              + [(i, "DOUBLE", None) for i in seg_items + h["event_items"]]
              + [(f, "DOUBLE", None) for s in h["sample_items"] for f in (s, f"cov_{s}")])
    rows = []
    for rid, b, e, a in segs:
        aid = asset_id(rid, b, e)
        s, o = samples[aid], others[aid]
        rows.append([aid, rid, state_of.get(rid), b, e, e - b] + [a[i] for i in seg_items]
                    + [o[i] for i in h["event_items"]]
                    + [v for x in h["sample_items"] for v in (s[x], s[f"cov_{x}"])])
    seg_table = os.path.join(scratch, "scored_section_events")
    common.write_rows(seg_table, fields, rows)
    temps.append(seg_table)

    lyr = arcpy.lr.MakeRouteEventLayer(hpms_routes, RID, seg_table, EVENT_PROPS, "scored_sections_lyr").getOutput(0)
    scored = os.path.join(build_gdb, "scored_sections")
    arcpy.management.CopyFeatures(lyr, scored)
    arcpy.management.Delete(lyr)
    for f, v in (("data_source", SOURCE), ("framework_role", "Tier 1 scored network"),
                 ("source_note", "HPMS sections segmented on " + ", ".join(seg_items))):
        arcpy.management.AddField(scored, f, "TEXT", field_length=255)
        arcpy.management.CalculateField(scored, f, repr(v), "PYTHON3")
    kept = [r[0] for r in arcpy.da.SearchCursor(scored, ["length_mi"])]
    print(f"scored_sections: {len(kept)} sections, {sum(kept):.1f} mi in the study area")

    params = {"segmentation_items": ",".join(seg_items), "merge_min_mi": h["merge_min_mi"],
              "span_tolerance": h["span_tolerance"], "tier1": f"F_System 1-{h['tier1_f_system_max']} or NHS>0 "
              f"or Facility_Type={h['ramp_facility_type']}", "wkid": cfg["crs"]["wkid"]}
    for target, title, abstract in (
        (hpms_routes, "HPMS 2024 routes (hpms_routes)",
         "M-enabled routes built with CreateRoutes from HPMS 2024 sections (Route_ID, Begin_Point, End_Point)."),
        (scored, "Scored network sections (scored_sections)",
         "Tier 1 HPMS sections, segmented where split-driver items change; asset_id = Route_ID_Begin_End."),
    ):
        common.write_metadata(target, title, abstract, [SOURCE], params, [hpms_routes, scored],
                              "build_hpms_network.py")
    common.cleanup(temps, keep)
    return hpms_routes, scored


if __name__ == "__main__":
    run()
