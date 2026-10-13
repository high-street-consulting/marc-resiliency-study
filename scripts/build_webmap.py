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
        item = find_item(gis, s["name"], "Feature Service")
        if item is None:
            sys.exit(f"{s['name']} is not on ArcGIS Online: {PUBLISH_HINT}")
        items[s["name"]] = item
    return items


def layer_index(cfg, items):
    # display name -> (item, hosted layer); hosted layers keep the map layer names publish_agol.py set
    out = {}
    for s in cfg["services"]:
        item = items[s["name"]]
        by_name = {lyr.properties.name: lyr for lyr in item.layers}
        for spec in s["layers"]:
            if spec["name"] not in by_name:
                sys.exit(f"{spec['name']} is not a layer of {s['name']}: {PUBLISH_HINT}")
            out[spec["name"]] = (item, by_name[spec["name"]])
    return out


def webmap_json(cfg, items):
    wm = cfg["webmap"]
    layers = layer_index(cfg, items)
    groups = []
    for sec in wm["sections"]:
        children = []
        for name in sec["layers"]:
            item, lyr = layers[name]
            children.append({"id": slug(name), "title": name, "layerType": "ArcGISFeatureLayer",
                             "itemId": item.id, "url": lyr.url, "visibility": True})
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
    text = json.dumps(webmap_json(cfg, items))
    title = cfg["webmap"]["title"]
    item = find_item(gis, title, "Web Map")
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
        json.dump({"webMapId": item.id}, f)
        f.write("\n")
    print(f"wrote {out}\n{item.homepage}")
    return item


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--config", default=CONFIG)
    p.add_argument("--sharing", choices=list(LEVELS))
    a = p.parse_args()
    run(a.config, a.sharing)
