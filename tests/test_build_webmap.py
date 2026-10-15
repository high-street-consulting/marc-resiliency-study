import copy
r"""Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I tests\test_build_webmap.py"""
import json
import os
import sys
import tempfile
from types import SimpleNamespace as NS
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
sys.modules["arcgis"] = mock.MagicMock()
sys.modules["arcgis.gis"] = mock.MagicMock()
import build_webmap

EXTENT = {"xmin": 1, "ymin": 2, "xmax": 3, "ymax": 4, "spatialReference": {"wkid": 102100}}


def fake_item(title, item_id, layer_names=()):
    url = f"https://services.example.com/{title}/FeatureServer"
    layers = [NS(url=f"{url}/{i}", properties=NS(name=n, extent=EXTENT)) for i, n in enumerate(layer_names)]
    return NS(title=title, id=item_id, url=url, layers=layers, homepage="https://example.com/wm",
              sharing=NS(sharing_level=None), update=mock.MagicMock())


def fake_gis(cfg, drop=None, webmap=None):
    # items by id: services, external layers and (optionally) the web map, as gis.content.get resolves them
    # an fgdb service without item_id is "not published yet" and must be skipped, not fatal
    items = {s["item_id"]: fake_item(s["name"], s["item_id"], [l["name"] for l in s["layers"]])
             for s in cfg["services"] if s.get("item_id")}
    items.pop(drop, None)
    for e in cfg["webmap"].get("external", []):
        items[e["item_id"]] = fake_item(e["name"], e["item_id"])
    if webmap:
        items[webmap.id] = webmap
    created = NS(id="new-webmap", homepage="https://example.com/new", sharing=NS(sharing_level=None))
    gis = NS(users=NS(me=NS(username="me")),
             content=NS(get=items.get, search=lambda q, item_type, max_items: [],
                        add=mock.MagicMock(return_value=created)))
    return gis, items, created


def leaves(layers):
    for l in layers:
        yield from leaves(l["layers"]) if l["layerType"] == "GroupLayer" else [l]


def test_webmap_json():
    cfg = build_webmap.load()
    scen = next(s for s in cfg["services"] if s.get("method") == "fgdb")
    scen["item_id"] = "scen"
    gis, _, _ = fake_gis(cfg)
    wm = build_webmap.webmap_json(gis, cfg, build_webmap.find_services(gis, cfg))
    ops = wm["operationalLayers"]
    assert len(ops) == len(cfg["webmap"]["sections"]) and all(g["layerType"] == "GroupLayer" for g in ops)
    # arrays run bottom-to-top, so the listed (top-down) order is the reverse
    assert [g["title"] for g in reversed(ops)] == [s["name"] for s in cfg["webmap"]["sections"]]
    by_title = {l["title"]: l for g in ops for l in g["layers"]}
    # multi-symbology layer = exclusive group, one visible child, each child carrying its own renderer
    net = by_title["Vulnerability assessment network"]
    assert net["layerType"] == "GroupLayer" and net["visibilityMode"] == "exclusive"
    assert sum(c["visibility"] for c in net["layers"]) == 1
    assert {c["layerDefinition"]["drawingInfo"]["renderer"]["field"] for c in net["layers"]} == {"redundancy_detour_mi", "centrality"}
    assert len({c["id"] for c in leaves(ops)}) == len(list(leaves(ops)))
    # scenario rows: exclusive group per measure, one option per published scenario layer
    zones = by_title["Stranded zones"]
    assert zones["visibilityMode"] == "exclusive" and [o["title"] for o in zones["layers"]] == ["FEMA 1% floodplain (method test)"]
    assert zones["layers"][0]["layerDefinition"]["definitionExpression"].startswith("threshold_ft = ")
    assert zones["layers"][0]["url"].endswith("/FeatureServer/1") and zones["layers"][0]["itemId"] == "scen"
    for row in ("Stranded zones", "Closed segments", "Detour paths"):  # rows start off; first option draws once a row is on
        assert not by_title[row]["visibility"] and by_title[row]["layers"][0]["visibility"]
    fema = by_title["FEMA flood hazard areas"]
    assert fema["url"] == cfg["webmap"]["external"][0]["url"] and fema["itemId"] == cfg["webmap"]["external"][0]["item_id"]
    assert fema["opacity"] < 1 and fema["layerDefinition"]["drawingInfo"]["renderer"]["type"] == "simple"
    assert fema["layerDefinition"]["minScale"] == 0
    assert by_title["Counties"]["url"].endswith("/FeatureServer/3")
    assert wm["initialState"]["viewpoint"]["targetGeometry"] == EXTENT
    assert wm["baseMap"]["title"] == "Light Gray Canvas"


def test_missing_service_exits():
    cfg = build_webmap.load()
    gis, _, _ = fake_gis(cfg, drop=cfg["services"][0]["item_id"])
    # unpublished fgdb service is skipped with a note, and its scenario rows are left out
    unpub = copy.deepcopy(cfg)
    for s in unpub["services"]:
        if s.get("method") == "fgdb":
            s.pop("item_id", None)
    ok, _, _ = fake_gis(unpub)
    wm = build_webmap.webmap_json(ok, unpub, build_webmap.find_services(ok, unpub))
    assert "Scenarios" not in [g["title"] for g in wm["operationalLayers"]]
    try:
        build_webmap.find_services(gis, cfg)
    except SystemExit as e:
        assert "publish first: run scripts/publish_agol.py" in str(e)
    else:
        raise AssertionError("missing service did not exit")


def test_run_updates_by_id_or_creates():
    cfg = build_webmap.load()
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "webmap.json")
        existing = fake_item(cfg["webmap"]["title"], cfg["webmap"]["item_id"])
        gis, items, _ = fake_gis(cfg, webmap=existing)
        build_webmap.run(sharing="org", gis=gis, out=out)
        assert not gis.content.add.called and existing.update.called
        assert existing.sharing.sharing_level == "ORGANIZATION"
        assert all(i.sharing.sharing_level == "ORGANIZATION" for k, i in items.items() if k in {s.get("item_id") for s in cfg["services"]})
        assert json.load(open(out))["webMapId"] == existing.id

        cfg["webmap"].pop("item_id")  # no id: create a new map
        gis, items, created = fake_gis(cfg)
        build_webmap.run(gis=gis, out=out)
        assert gis.content.add.call_args.kwargs["folder"] == cfg["portal_folder"]
        assert created.sharing.sharing_level == "EVERYONE"
        assert json.load(open(out))["webMapId"] == "new-webmap"
        assert json.load(open(out))["defaultThresholdFt"] in json.load(open(out))["thresholdsFt"]


if __name__ == "__main__":
    test_webmap_json()
    test_missing_service_exits()
    test_run_updates_by_id_or_creates()
    print("ok")
