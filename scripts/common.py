import datetime
import os
import tomllib

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(REPO, "config", "build.toml")


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
