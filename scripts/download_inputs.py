# Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\download_inputs.py [pbf] [hpms] [acs]
import csv
import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

GEOFABRIK = "https://download.geofabrik.de/north-america/us/{state}-{stamp}.osm.pbf"
HPMS = "https://geo.dot.gov/server/rest/services/Hosted/{layer}/FeatureServer/0/query"
ACS_SF = "https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/acsdt5y2024-b01001.dat"
# Study-area envelope (county_boundaries in WGS84) plus about 5 km.
BBOX = "-95.25,38.33,-93.70,39.60"
COUNTIES = {"20": "091,103,121,209", "29": "037,047,095,165,177"}
UNDER18 = [f"B01001_E{i:03d}" for i in (*range(3, 7), *range(27, 31))]
AGE65 = [f"B01001_E{i:03d}" for i in (*range(20, 26), *range(44, 50))]


def get(url, params=None):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=300) as r:
        return r.read()


def download_pbf(out_dir, stamp="261012"):
    os.makedirs(out_dir, exist_ok=True)
    for state in ("kansas", "missouri"):
        url = GEOFABRIK.format(state=state, stamp=stamp)
        urllib.request.urlretrieve(url, os.path.join(out_dir, os.path.basename(url)))
        print(url)


def download_hpms(cfg):
    import arcpy
    arcpy.env.overwriteOutput = True
    gdb = common.ensure_gdb(common.repo_path(cfg["inputs"]["hpms_gdb"]))
    page_dir = os.path.join(os.path.dirname(gdb), "pages")
    os.makedirs(page_dir, exist_ok=True)
    for layer in cfg["inputs"]["hpms_layers"].values():
        url = HPMS.format(layer=layer)
        out_fc = os.path.join(gdb, layer)
        offset, n = 0, 0
        while True:
            body = get(url, {
                "where": "1=1", "geometry": BBOX, "geometryType": "esriGeometryEnvelope", "inSR": 4326,
                "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "returnGeometry": "true",
                "returnM": "true", "outSR": 4326, "orderByFields": "objectid",
                "resultOffset": offset, "resultRecordCount": 2000, "f": "json",
            })
            page = json.loads(body)
            if "error" in page:
                raise RuntimeError(f"{layer} offset {offset}: {page['error']}")
            feats = page.get("features", [])
            if not feats:
                break
            path = os.path.join(page_dir, f"{layer}_{offset:07d}.json")
            with open(path, "wb") as f:
                f.write(body)
            tmp = os.path.join(gdb, "page_tmp")
            arcpy.conversion.JSONToFeatures(path, tmp)
            if offset == 0:
                arcpy.management.CopyFeatures(tmp, out_fc)
            else:
                arcpy.management.Append(tmp, out_fc, "NO_TEST")
            n += len(feats)
            offset += len(feats)
            print(f"{layer}: {n}")
            if not page.get("exceededTransferLimit"):
                break
        arcpy.management.Delete(os.path.join(gdb, "page_tmp"))
        print(f"{layer}: {n} sections -> {out_fc}")


def download_acs(cfg):
    # The Census API now requires a key; the table-based summary file does not.
    out = common.repo_path(cfg["inputs"]["acs_csv"])
    raw = os.path.join(os.path.dirname(out), os.path.basename(ACS_SF))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if not os.path.exists(raw):
        urllib.request.urlretrieve(ACS_SF, raw)
    prefixes = tuple(f"1400000US{st}{c}" for st, cs in COUNTIES.items() for c in cs.split(","))
    rows = []
    with open(raw, encoding="utf-8") as f:
        head = f.readline().rstrip("\r\n").split("|")
        idx = {h: i for i, h in enumerate(head)}
        for line in f:
            if not line.startswith(prefixes):
                continue
            r = line.rstrip("\r\n").split("|")
            val = lambda v: int(float(r[idx[v]] or 0))
            rows.append({
                "GeoID": r[idx["GEO_ID"]][9:],
                "pop_total": val("B01001_E001"),
                "pop_under18": sum(val(v) for v in UNDER18),
                "pop_65plus": sum(val(v) for v in AGE65),
            })
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"ACS: {len(rows)} tracts -> {out}")


if __name__ == "__main__":
    cfg = common.load_config()
    what = sys.argv[1:] or ["pbf", "hpms", "acs"]
    if "pbf" in what:
        download_pbf(common.repo_path("data/downloads/geofabrik"))
    if "hpms" in what:
        download_hpms(cfg)
    if "acs" in what:
        download_acs(cfg)
