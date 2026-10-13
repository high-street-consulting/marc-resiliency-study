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


def fake_item(title, layer_names):
    url = f"https://services.example.com/{title}/FeatureServer"
    layers = [NS(url=f"{url}/{i}", properties=NS(name=n, extent=EXTENT)) for i, n in enumerate(layer_names)]
    return NS(title=title, id=title.lower(), url=url, layers=layers, homepage="https://example.com/wm",
              sharing=NS(sharing_level=None), update=mock.MagicMock())


def fake_gis(cfg, drop=None, webmap=None):
    items = {s["name"]: fake_item(s["name"], [l["name"] for l in s["layers"]]) for s in cfg["services"]}
    items.pop(drop, None)
    if webmap:
        items[webmap.title] = webmap

    def search(q, item_type, max_items):
        return [i for t, i in items.items() if f'"{t}"' in q]

    created = NS(id="new-webmap", homepage="https://example.com/new", sharing=NS(sharing_level=None))
    gis = NS(users=NS(me=NS(username="me")),
             content=NS(search=search, add=mock.MagicMock(return_value=created)))
    return gis, items, created


def test_webmap_json():
    cfg = build_webmap.load()
    gis, _, _ = fake_gis(cfg)
    wm = build_webmap.webmap_json(cfg, build_webmap.find_services(gis, cfg))
    ops = wm["operationalLayers"]
    assert len(ops) == 3 and all(g["layerType"] == "GroupLayer" for g in ops)
    # arrays run bottom-to-top, so the listed (top-down) order is the reverse
    assert [g["title"] for g in reversed(ops)] == [s["name"] for s in cfg["webmap"]["sections"]]
    listed = [l["title"] for g in reversed(ops) for l in reversed(g["layers"])]
    assert listed[-1] == "Counties" and ops[0]["layers"][0]["title"] == "Counties"
    counties = ops[0]["layers"][0]
    assert counties["itemId"] == "marc_resilience_phase2_reference" and counties["url"].endswith("/FeatureServer/0")
    assert wm["initialState"]["viewpoint"]["targetGeometry"] == EXTENT
    assert wm["baseMap"]["title"] == "Light Gray Canvas"


def test_missing_service_exits():
    cfg = build_webmap.load()
    gis, _, _ = fake_gis(cfg, drop="MARC_Resilience_Phase2_Reference")
    try:
        build_webmap.find_services(gis, cfg)
    except SystemExit as e:
        assert "publish first: run scripts/publish_agol.py" in str(e)
    else:
        raise AssertionError("missing service did not exit")


def test_run_creates_then_updates():
    cfg = build_webmap.load()
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "webmap.json")
        gis, items, created = fake_gis(cfg)
        build_webmap.run(gis=gis, out=out)
        assert gis.content.add.call_args.kwargs["folder"] == cfg["portal_folder"]
        assert json.load(open(out)) == {"webMapId": "new-webmap"}
        assert created.sharing.sharing_level == "EVERYONE"
        assert all(i.sharing.sharing_level == "EVERYONE" for i in items.values())

        existing = fake_item(cfg["webmap"]["title"], [])
        gis, items, _ = fake_gis(cfg, webmap=existing)
        build_webmap.run(sharing="org", gis=gis, out=out)
        assert not gis.content.add.called and existing.update.called
        assert existing.sharing.sharing_level == "ORGANIZATION"
        assert json.load(open(out)) == {"webMapId": existing.id}


if __name__ == "__main__":
    test_webmap_json()
    test_missing_service_exits()
    test_run_creates_then_updates()
    print("ok")
