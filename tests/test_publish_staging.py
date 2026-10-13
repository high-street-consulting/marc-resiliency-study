r"""Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I tests\test_publish_staging.py"""
import datetime
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import publish_agol


def test_stage_only():
    import arcpy
    cfg = publish_agol.load()
    out = os.path.join(HERE, "output", datetime.date.today().isoformat(), "publish")
    os.makedirs(out, exist_ok=True)
    aprx = os.path.join(out, os.path.basename(cfg["aprx"]))
    shutil.copy2(cfg["aprx"], aprx)

    sds = publish_agol.run(aprx_path=aprx, staging_dir=out, stage_only=True)

    for s in cfg["services"]:
        assert os.path.getsize(sds[s["name"]]) > 0
    m = arcpy.mp.ArcGISProject(aprx).listMaps(cfg["map"])[0]
    names = [l.name for l in m.listLayers()]
    for s in cfg["services"]:
        for spec in s["layers"]:
            assert names.count(spec["name"]) == 1, (spec["name"], names)


if __name__ == "__main__":
    test_stage_only()
    print("ok")
