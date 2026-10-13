r"""Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I tests\test_lrs.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import lrs

# Route R1, three events: 0-1 (aadt 1000, class A), 1-3 (aadt 4000, class B), 3-4 (no aadt, class B, lanes 6).
EVENTS = [
    ("R1", 0.0, 1.0, {"aadt": 1000, "cls": "A", "lanes": 2}),
    ("R1", 1.0, 3.0, {"aadt": 4000, "cls": "B", "lanes": 4}),
    ("R1", 4.0, 3.0, {"aadt": None, "cls": "B", "lanes": 6}),
]
RULES = {"aadt": "mean", "cls": "majority", "lanes": "max"}


def test_overlap_weighting():
    out = lrs.aggregate([("s1", "R1", 0.5, 2.0)], EVENTS, RULES)["s1"]
    assert abs(out["aadt"] - (0.5 * 1000 + 1.0 * 4000) / 1.5) < 1e-9
    assert out["cls"] == "B" and out["lanes"] == 4
    assert out["cov_aadt"] == 1.0


def test_partial_coverage_and_reversed_measures():
    out = lrs.aggregate([("s2", "R1", 4.0, 2.5)], EVENTS, RULES)["s2"]
    assert out["aadt"] == 4000
    assert abs(out["cov_aadt"] - 0.5 / 1.5) < 1e-9
    assert out["lanes"] == 6 and out["cov_lanes"] == 1.0


def test_no_match_and_point_target():
    res = lrs.aggregate([("s3", "R2", 0, 1), ("p", "R1", 1.5, 1.5)], EVENTS, RULES)
    assert res["s3"]["aadt"] is None and res["s3"]["cov_aadt"] == 0.0
    assert res["p"]["aadt"] == 4000 and res["p"]["cov_aadt"] == 1.0


def test_point_events_land_once():
    bridges = [("R1", 1.0, 1.0, {"cond": 5}), ("R1", 1.2, 1.2, {"cond": 7})]
    res = lrs.aggregate([("a", "R1", 0, 1), ("b", "R1", 1, 3)], bridges, {"cond": "min"})
    assert res["a"]["cond"] is None and res["b"]["cond"] == 5


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
