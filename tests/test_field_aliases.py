r"""Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I -m pytest tests\test_field_aliases.py"""
import csv
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import common

ALIASES = common.load_aliases()
SCENARIOS = [
    {"name": "fema_1pct", "label": "FEMA 1% floodplain (method test)", "return_period": 100, "year": "cur"},
    {"return_period": 100, "year": "2050", "ssp": "ssp245"},
]


def a(name):
    return common.alias_for(name, ALIASES, SCENARIOS)


def test_resolution_rules():
    assert a("aadt") == "AADT"
    assert a("cov_iri") == "Coverage: IRI"
    assert a("closed_rp100_2050_ssp245") == "Closed: 100-yr, 2050, SSP2-4.5"
    assert a("detour_mi_rp100_2050_ssp245") == "Detour (mi): 100-yr, 2050, SSP2-4.5"
    assert a("closed_fema_1pct") == "Closed: FEMA 1% floodplain (method test)"
    assert a("DECK_COND_058") == "Deck condition"
    assert a("TRAFFIC_LANES_ON_028A") == "Traffic lanes on (NBI 28A)"
    assert a("some_name") == "Some name"


def test_system_fields_skipped():
    for name in ("OBJECTID", "Shape", "Shape_Length", "SHAPE_Area", "GlobalID"):
        assert a(name) is None


def test_csv_fields_unique():
    with open(common.ALIASES, newline="", encoding="utf-8") as f:
        names = [r["field"] for r in csv.DictReader(f)]
    assert len(names) == len(set(names))
