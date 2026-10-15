import csv
import datetime
import os
import re
import tomllib

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(REPO, "config", "build.toml")
ALIASES = os.path.join(REPO, "config", "field_aliases.csv")


def load_config(path=CONFIG):
    with open(path, "rb") as f:
        return tomllib.load(f)


def repo_path(p):
    return p if not p or os.path.isabs(p) else os.path.join(REPO, p)


def ensure_gdb(path):
    import arcpy
    if not arcpy.Exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        arcpy.management.CreateFileGDB(os.path.dirname(path), os.path.basename(path))
    return path


def setup_scratch(cfg):
    import arcpy
    arcpy.env.overwriteOutput = True
    configured = cfg["paths"].get("scratch_gdb", "")
    scratch = ensure_gdb(repo_path(configured)) if configured else arcpy.env.scratchGDB
    keep = bool(configured) and cfg["paths"].get("keep_intermediates", False)
    print(f"scratch: {scratch} (keep intermediates: {keep})")
    return scratch, keep


def cleanup(paths, keep):
    if keep:
        return
    import arcpy
    for p in paths:
        if arcpy.Exists(p):
            arcpy.management.Delete(p)


def spatial_ref(cfg):
    import arcpy
    return arcpy.SpatialReference(cfg["crs"]["wkid"])


def write_metadata(target, title, abstract, sources, params, outputs, script):
    # MARC standard: ISO 19139 metadata from a fixed template, categories not tags.
    from arcpy import metadata as md
    m = md.Metadata(target)
    m.title = title
    m.summary = abstract
    lines = [
        abstract,
        "",
        f"Built {datetime.date.today().isoformat()} by scripts/{script}.",
        "Inputs: " + "; ".join(sources),
        "Parameters: " + "; ".join(f"{k}={v}" for k, v in params.items()),
        "Outputs: " + "; ".join(outputs),
    ]
    m.description = "\n".join(lines)
    m.credits = "Mid-America Regional Council (MARC) Transportation Resilience Phase 2; " + "; ".join(sources)
    m.accessConstraints = "MARC project data. Contact MARC GIS for use outside the project."
    m.save()


def write_rows(path, fields, rows, geometry_type=None, spatial_reference=None):
    # fields: [(name, type, length)]; rows: sequences in field order (geometry first when geometry_type is set).
    import arcpy
    ws, name = os.path.dirname(path), os.path.basename(path)
    if arcpy.Exists(path):
        arcpy.management.Delete(path)
    if geometry_type:
        arcpy.management.CreateFeatureclass(ws, name, geometry_type, spatial_reference=spatial_reference)
    else:
        arcpy.management.CreateTable(ws, name)
    for fname, ftype, flen in fields:
        arcpy.management.AddField(path, fname, ftype, field_length=flen)
    cols = (["SHAPE@"] if geometry_type else []) + [f[0] for f in fields]
    n = 0
    with arcpy.da.InsertCursor(path, cols) as cur:
        for r in rows:
            cur.insertRow(r)
            n += 1
    return n


SKIP_ALIAS = re.compile(r"^(objectid|shape|shape_length|shape_area|globalid)$", re.I)
NBI_ITEM = re.compile(r"^[A-Z][A-Z_]+_(\d{3}[A-E]?)$")
SSP = {"ssp245": "SSP2-4.5", "ssp585": "SSP5-8.5"}


def load_aliases(path=ALIASES):
    with open(path, newline="", encoding="utf-8") as f:
        return {r["field"]: r["alias"] for r in csv.DictReader(f)}


def scenario_label(s):
    if s.get("label"):
        return s["label"]
    if s["year"] == "cur":
        return f"{s['return_period']}-yr, current"
    return f"{s['return_period']}-yr, {s['year']}, {SSP.get(s['ssp'], s['ssp'])}"


def alias_for(name, aliases, scenarios=()):
    if SKIP_ALIAS.match(name):
        return None
    if name in aliases:
        return aliases[name]
    if name.startswith("cov_"):
        return "Coverage: " + alias_for(name[4:], aliases, scenarios)
    import run_network_analysis
    for s in scenarios:
        sn = run_network_analysis.scenario_name(s)
        for prefix, label in (("closed_", "Closed"), ("stranded_", "Stranded"), ("detour_mi_", "Detour (mi)")):
            if name == prefix + sn:
                return f"{label}: {scenario_label(s)}"
    m = NBI_ITEM.match(name)
    if m:
        words = name[:m.start(1) - 1].replace("_", " ").capitalize()
        return f"{words} (NBI {m.group(1).lstrip('0')})"
    return name.replace("_", " ").capitalize()


NEW_TYPES = {"BigInteger", "DateOnly", "TimeOnly", "TimestampOffset"}


def demote_new_types(path):
    # Rewrite in place with classic field types only (see global CLAUDE.md): BigInteger -> LONG when every value fits, else DOUBLE.
    import arcpy
    bad = [f for f in arcpy.ListFields(path) if f.type in NEW_TYPES]
    if not bad:
        return 0
    if {f.type for f in bad} - {"BigInteger"}:
        raise ValueError(f"{path}: unsupported field types {[f.name + ':' + f.type for f in bad]}")
    names = [f.name for f in bad]
    big = set()
    for row in arcpy.da.SearchCursor(path, names):
        big.update(n for n, v in zip(names, row) if v is not None and abs(v) > 2**31 - 1)
    fm = arcpy.FieldMappings()
    fm.addTable(path)
    for n in names:
        i = fm.findFieldMapIndex(n)
        m = fm.getFieldMap(i)
        f = m.outputField
        f.type = "Double" if n in big else "Long"
        m.outputField = f
        fm.replaceFieldMap(i, m)
    ws, name = os.path.dirname(path), os.path.basename(path)
    tmp = os.path.join(ws, name + "_classic")
    is_fc = arcpy.Describe(path).dataType == "FeatureClass"
    (arcpy.conversion.ExportFeatures if is_fc else arcpy.conversion.ExportTable)(path, tmp, field_mapping=fm)
    arcpy.management.Delete(path)
    arcpy.management.Rename(tmp, name)
    return len(names)


def apply_aliases(path, aliases, scenarios=()):
    import arcpy
    n = 0
    for f in arcpy.ListFields(path):
        alias = alias_for(f.name, aliases, scenarios)
        if alias and f.aliasName == f.name and alias != f.name:
            arcpy.management.AlterField(path, f.name, new_field_alias=alias)
            n += 1
    return n
