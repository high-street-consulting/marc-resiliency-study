# Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\build_webmap.py [--sharing private|org|everyone]
import argparse
import json
import os
import re
import sys
import tomllib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

CONFIG = os.path.join(common.REPO, "config", "publish.toml")
WEBMAP_JSON = os.path.join(common.REPO, "app", "src", "config", "webmap.json")
LEVELS = {"private": "PRIVATE", "org": "ORGANIZATION", "everyone": "EVERYONE"}
PUBLISH_HINT = "publish first: run scripts/publish_agol.py"

VECTOR = "https://cdn.arcgis.com/sharing/rest/content/items/{}/resources/styles/root.json"
BASEMAPS = {
    "gray-vector": {
        "title": "Light Gray Canvas",
        "baseMapLayers": [
            {"id": "gray-base", "title": "Light Gray Base", "layerType": "VectorTileLayer",
             "itemId": "291da5eab3a0412593b66d384379f89f",
             "styleUrl": VECTOR.format("291da5eab3a0412593b66d384379f89f"), "visibility": True, "opacity": 1},
            {"id": "gray-reference", "title": "Light Gray Reference", "layerType": "VectorTileLayer",
             "itemId": "1768e8369a214dfab4e2167d5c5f2454", "isReference": True,
             "styleUrl": VECTOR.format("1768e8369a214dfab4e2167d5c5f2454"), "visibility": True, "opacity": 1},
        ],
    },
}


def line(rgb, width):
    return {"type": "esriSLS", "style": "esriSLSSolid", "color": [*rgb, 255], "width": width}



def breaks(field, classes, default_label, default_width=0.8):
    # classes: (max, label, rgb, width); minValue is the previous max.
    infos, lo = [], 0
    for hi, label, rgb, width in classes:
        infos.append({"classMinValue": lo, "classMaxValue": hi, "label": label, "symbol": line(rgb, width)})
        lo = hi
    return {"type": "classBreaks", "field": field, "minValue": 0, "classBreakInfos": infos,
            "defaultSymbol": {**line([150, 150, 150], default_width), "style": "esriSLSDash"},
            "defaultLabel": default_label}


def num(name, label, places):
    return {"fieldName": name, "label": label, "visible": True, "format": {"places": places, "digitSeparator": True}}


# Single-hue ramp on the MARC teal (landing.css --teal #31787d), light to dark; red is reserved for the brand stripe.
# The floor starts mid-pale: a near-white step vanished against basemap water and the FEMA fill.
TEAL = [[156, 203, 207], [120, 184, 189], [95, 165, 172], [49, 120, 125], [23, 71, 75]]
# Esri "Blue 28" ramp (ArcGIS Maps SDK colorRamps: #c3cad9 #a9b3c9 #8898c0 #6d7fad #505e85), scenario rows only.
BLUE28 = [[195, 202, 217], [169, 179, 201], [136, 152, 192], [109, 127, 173], [80, 94, 133]]

ALIASES = common.load_aliases()


def section_num(name, places):
    return num(name, common.alias_for(name, ALIASES), places)


SECTION_POPUP = {
    "title": "{route_id}: {begin_point} to {end_point} mi",
    "fieldInfos": [
        {"fieldName": "routenumber", "label": common.alias_for("routenumber", ALIASES), "visible": True},
        section_num("f_system", 0), section_num("aadt", 0), section_num("nhs", 0),
        section_num("length_mi", 2),
        section_num("redundancy_detour_mi", 2),
        section_num("redundancy_no_path", 0),
        section_num("centrality", 4),
    ],
}

# Display name -> one entry (plain layer) or a list of entries (exclusive group, one child per symbology).
# Each entry: title, layer def, popup, visibility, opacity. Renderers are the only symbology source.
STYLES = {
    "Vulnerability assessment network": [
        {"title": "Redundancy: detour if segment is lost (mi)", "visible": True, "opacity": 0.7, "popup": SECTION_POPUP,
         "def": {"drawingInfo": {"renderer": breaks("redundancy_detour_mi", [
             (1, "Under 1 mi", TEAL[0], 1.2), (2, "1 to 2 mi", TEAL[1], 1.6),
             (5, "2 to 5 mi", TEAL[2], 2.0), (10, "5 to 10 mi", TEAL[3], 2.6),
             (100, "Over 10 mi", TEAL[4], 3.4)],
             "Not measured (no alternative within 20 mi; one-way chain artifact, not scored)")}}},
        {"title": "Network role: betweenness centrality", "visible": False, "opacity": 0.7, "popup": SECTION_POPUP,
         "def": {"drawingInfo": {"renderer": breaks("centrality", [
             (0.001, "Lowest", TEAL[0], 1.2), (0.003, "Low", TEAL[1], 1.6),
             (0.006, "Medium", TEAL[2], 2.0), (0.02, "High", TEAL[3], 2.6),
             (1, "Highest", TEAL[4], 3.4)], "No value")}}},
    ],
    "Stranded zone network": {"visible": False, "def": {"minScale": 144448, "drawingInfo": {"renderer": {
        "type": "simple", "symbol": line([120, 120, 120], 0.6)}}}},
    "Bridges (NBI)": {"visible": False},
    # The Living Atlas service sets minScale 400,000; overriding it lets the fill draw at the regional
    # default zoom (~1:2.3M). If first paint at zoom 8 is slow, publish a dissolved/simplified SFHA overview
    # from data/downloads/fema/nfhl.gdb (nfhl_sfha, 11,520 features) and pair the two by scale.
    "FEMA flood hazard areas": {"visible": False, "opacity": 0.4, "def": {"minScale": 0, "drawingInfo": {"renderer": {
        "type": "simple", "label": "FEMA flood hazard area",
        "symbol": {"type": "esriSFS", "style": "esriSFSSolid", "color": [70, 140, 220, 255],
                   "outline": {"type": "esriSLS", "style": "esriSLSNull", "width": 0}}}}},
        "popup": {"title": "{esri_symbology}", "fieldInfos": [
            {"fieldName": "FLD_ZONE", "label": "FEMA zone", "visible": True},
            {"fieldName": "ZONE_SUBTY", "label": "Subtype", "visible": True}]}},
    "Counties": {"visible": False, "popup": {"title": "{NAME}", "fieldInfos": []}, "def": {"drawingInfo": {"renderer": {
        "type": "simple", "symbol": {"type": "esriSFS", "style": "esriSFSNull", "color": [0, 0, 0, 0],
                                     "outline": line([90, 90, 90], 1.2)}}}}},
}

ZONE_POPUP = {"title": "{zone_type} zone {zone_id}", "fieldInfos": [
    num("threshold_ft", "Closure depth (ft)", 1),
    num("miles", "Road miles", 1), num("population", "Population (2020, allocated)", 0), num("jobs", "Jobs (2020, allocated)", 0),
    num("facilities", "Critical facilities", 0), num("egress_baseline", "Ways out at baseline", 0),
    num("egress_scenario", "Ways out in scenario", 0),
    num("elderly_share", "Share 65 and over", 2), num("mobility_disab_share", "Share with mobility disability", 2)]}

# measure (catalog row) -> (service layer prefix, style of each scenario's layer)
# Scenario results take Blue 28 stops two apart so no two classes are neighbours on the ramp: darkest = cut off,
# middle = one way out, darkest dashed = closures, lightest and wider = detours; 60% so basemap roads show through.
SCENARIO_MEASURES = {
    "Stranded zones": ("stranded_zones_", {"opacity": 0.6, "popup": ZONE_POPUP, "def": {"drawingInfo": {"renderer": {
        "type": "uniqueValue", "field1": "zone_type", "uniqueValueInfos": [
            {"value": "stranded", "label": "Stranded (cut off from the main network)", "symbol": line(BLUE28[4], 1.8)},
            {"value": "single_egress", "label": "Single egress (one way out left)", "symbol": line(BLUE28[2], 1.4)}]}}}}),
    "Closed segments": ("closed_edges_", {"opacity": 0.6, "popup": {"title": "Closed edge {edge_id}", "fieldInfos": [
        num("threshold_ft", "Closure depth (ft)", 1), num("detour_mi", "Detour around it (mi)", 2), num("no_detour", "No detour (1 = cut off)", 0)]},
        "def": {"drawingInfo": {"renderer": {"type": "simple", "symbol": {**line(BLUE28[4], 1.2), "style": "esriSLSDash"}}}}}),
    "Detour paths": ("detours_", {"opacity": 0.6, "popup": {"title": "Detour for {closed_edge_id}", "fieldInfos": [
        num("threshold_ft", "Closure depth (ft)", 1), num("detour_mi", "Detour length (mi)", 2), num("path_edges", "Edges on path", 0)]},
        "def": {"drawingInfo": {"renderer": {"type": "simple", "symbol": line(BLUE28[0], 2.2)}}}}),
}


def scenario_styles(scenarios, layer_names, default_ft):
    # One exclusive group per measure; one option per scenario whose layer is published. First option draws.
    import run_network_analysis as rna
    out = {}
    for measure, (prefix, style) in SCENARIO_MEASURES.items():
        opts = []
        for s in scenarios:
            lname = prefix + rna.scenario_name(s)
            if lname in layer_names:
                # Layers carry every closure depth step; draw only the default until the app picks one.
                d = {**style["def"], "definitionExpression": f"threshold_ft = {default_ft}"}
                # Scenario rows start off: Explore opens on the networks, the Stranded Zones tab turns these on.
                opts.append({**style, "def": d, "on": False, "title": s.get("label", rna.scenario_name(s)), "layer": lname,
                             "visible": not opts})  # first scenario option draws once the row is on
        if opts:
            out[measure] = opts
    return out


def load(path=CONFIG):
    with open(path, "rb") as f:
        return tomllib.load(f)


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def plain(v):
    return {k: plain(x) for k, x in v.items()} if hasattr(v, "items") else v


def find_item(gis, title, item_type):
    hits = gis.content.search(f'title:"{title}" AND owner:{gis.users.me.username}',
                              item_type=item_type, max_items=10)
    return next((i for i in hits if i.title == title), None)


def find_services(gis, cfg):
    items = {}
    for s in cfg["services"]:
        item = gis.content.get(s["item_id"]) if s.get("item_id") else find_item(gis, s["name"], "Feature Service")
        if item is None:
            if s.get("method") == "fgdb":
                print(f"{s['name']} not published yet; its layers are left out of the web map")
                continue
            sys.exit(f"{s['name']} is not on ArcGIS Online: {PUBLISH_HINT}")
        items[s["name"]] = item
    return items


def layer_index(gis, cfg, items):
    # display name -> (item, hosted layer); hosted layers keep the map layer names publish_agol.py set
    out = {}
    for s in cfg["services"]:
        item = items.get(s["name"])
        if item is None:
            continue
        by_name = {lyr.properties.name: lyr for lyr in item.layers}
        for spec in s["layers"]:
            if spec["name"] not in by_name:
                sys.exit(f"{spec['name']} is not a layer of {s['name']}: {PUBLISH_HINT}")
            out[spec["name"]] = (item, by_name[spec["name"]])
    for ext in cfg["webmap"].get("external", []):
        out[ext["name"]] = (gis.content.get(ext["item_id"]), ext["url"])
    return out


def feature_layer(lid, title, item, url, style):
    lyr = {"id": lid, "title": title, "layerType": "ArcGISFeatureLayer", "itemId": item.id, "url": url,
           "visibility": style.get("visible", True), "opacity": style.get("opacity", 1)}
    if style.get("def"):
        lyr["layerDefinition"] = style["def"]
    if style.get("popup"):
        lyr["popupInfo"] = style["popup"]
    return lyr


def webmap_json(gis, cfg, items):
    wm = cfg["webmap"]
    layers = layer_index(gis, cfg, items)
    a = common.load_config()["analysis"]
    styles = {**scenario_styles(a["scenarios"], set(layers), a["depth_threshold_ft"]), **STYLES}
    groups = []
    for sec in wm["sections"]:
        children = []
        for name in sec["layers"]:
            style = styles.get(name, {})
            if name not in layers and not isinstance(style, list):
                print(f"{name}: no published layer yet, left out of the web map")
                continue
            if isinstance(style, list):  # one exclusive group, one child per symbology option
                opts = []
                for o in style:
                    item, lyr = layers[o.get("layer", name)]
                    url = lyr if isinstance(lyr, str) else lyr.url
                    opts.append(feature_layer(f"{slug(name)}-{slug(o['title'])}", o["title"], item, url, o))
                children.append({"id": slug(name), "title": name, "layerType": "GroupLayer",
                                 "visibility": style[0].get("on", True),  # the row; children keep their own default
                                 "visibilityMode": "exclusive", "layers": opts[::-1]})
            else:
                item, lyr = layers[name]
                url = lyr if isinstance(lyr, str) else lyr.url
                children.append(feature_layer(slug(name), name, item, url, style))
        if not children:
            continue
        # Web map arrays run bottom-to-top; the Map Viewer and the app list them top-down.
        groups.append({"id": slug(sec["name"]), "title": sec["name"], "layerType": "GroupLayer",
                       "visibility": True, "visibilityMode": "independent", "layers": children[::-1]})
    _, counties = layers["Counties"]
    return {
        "operationalLayers": groups[::-1],
        "baseMap": BASEMAPS[wm["basemap"]],
        "spatialReference": {"wkid": 102100, "latestWkid": 3857},
        "initialState": {"viewpoint": {"targetGeometry": plain(counties.properties.extent)}},
        "authoringApp": "build_webmap.py",
        "authoringAppVersion": "1",
        "version": "2.31",
    }


def run(config=CONFIG, sharing=None, out=WEBMAP_JSON, gis=None):
    cfg = load(config)
    if gis is None:
        from arcgis.gis import GIS
        gis = GIS("home")
    items = find_services(gis, cfg)
    text = json.dumps(webmap_json(gis, cfg, items))
    title = cfg["webmap"]["title"]
    item = gis.content.get(cfg["webmap"]["item_id"]) if cfg["webmap"].get("item_id") else find_item(gis, title, "Web Map")
    if item:
        item.update(item_properties={"text": text})
        print(f"updated web map {item.id}")
    else:
        item = gis.content.add({"title": title, "type": "Web Map", "text": text,
                                "tags": "MARC,resilience,web map",
                                "snippet": "Layers for the MARC Transportation Resilience Explorer."},
                               folder=cfg["portal_folder"])
        print(f"created web map {item.id}")
    level = LEVELS[sharing or cfg["webmap"].get("sharing", "org")]
    for i in [item, *items.values()]:
        i.sharing.sharing_level = level
    print(f"sharing {level}: {title} + {', '.join(items)}")
    with open(out, "w", encoding="utf-8") as f:
        a = common.load_config()["analysis"]
        json.dump({"webMapId": item.id, "thresholdsFt": a["depth_thresholds_ft"],
                   "defaultThresholdFt": a["depth_threshold_ft"]}, f)
        f.write("\n")
    print(f"wrote {out}\n{item.homepage}")
    return item


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--config", default=CONFIG)
    p.add_argument("--sharing", choices=list(LEVELS))
    a = p.parse_args()
    run(a.config, a.sharing)
