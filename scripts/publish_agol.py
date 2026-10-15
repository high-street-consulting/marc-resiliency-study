# Run: "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" -I scripts\publish_agol.py [--map-only | --stage-only | --fgdb | --aliases-only]
import argparse
import datetime
import os
import sys
import tomllib
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

CONFIG = os.path.join(common.REPO, "config", "publish.toml")


def load(path=CONFIG):
    with open(path, "rb") as f:
        return tomllib.load(f)


def build_map(aprx, cfg):
    import arcpy
    maps = aprx.listMaps(cfg["map"])
    m = maps[0] if maps else aprx.createMap(cfg["map"])
    wanted = {lyr["name"] for s in cfg["services"] if s.get("method") != "fgdb" for lyr in s["layers"]}
    for lyr in m.listLayers():
        if lyr.name in wanted:
            m.removeLayer(lyr)

    lyrx_cache = {}

    def source_layer(lyrx, name):
        if lyrx not in lyrx_cache:
            lyrx_cache[lyrx] = {l.name: l for l in arcpy.mp.LayerFile(lyrx).listLayers() if l.isFeatureLayer}
        return lyrx_cache[lyrx].get(name)

    out = {}
    for s in cfg["services"]:
        if s.get("method") == "fgdb":
            continue
        added = []
        for spec in s["layers"]:
            lyr = m.addDataFromPath(common.repo_path(spec["path"]))
            lyr.name = spec["name"]
            lyrx = spec.get("lyrx", s.get("lyrx"))
            if lyrx:
                src = source_layer(common.repo_path(lyrx), spec.get("lyrx_layer", spec["name"]))
                if src is None:
                    print(f"  {spec['name']}: no match in {os.path.basename(lyrx)}, default symbology")
                else:
                    lyr.symbology = src.symbology
                    print(f"  {spec['name']}: symbology from {os.path.basename(lyrx)}")
            added.append(lyr)
        out[s["name"]] = added
    print(f"map '{m.name}': {[l.name for l in m.listLayers()]}")
    return m, out


def stage(m, service, layers, cfg, staging_dir):
    import arcpy
    os.makedirs(staging_dir, exist_ok=True)
    name = service["name"]
    draft = m.getWebLayerSharingDraft("HOSTING_SERVER", "FEATURE", name, layers)
    draft.overwriteExistingService = cfg.get("overwrite", True)
    draft.portalFolder = cfg["portal_folder"]
    draft.summary = service["summary"]
    # Same template as common.write_metadata (step 6).
    draft.description = "\n".join([
        service["description"],
        "",
        f"Published {datetime.date.today().isoformat()} by scripts/publish_agol.py.",
        "Inputs: " + "; ".join(common.repo_path(l["path"]) for l in service["layers"]),
        "Access: " + cfg["access"],
    ]).replace("\n", "<br>")
    draft.credits = cfg["credits"]
    draft.tags = ",".join(service.get("tags", []))
    sddraft = os.path.join(staging_dir, name + ".sddraft")
    sd = os.path.join(staging_dir, name + ".sd")
    draft.exportToSDDraft(sddraft)
    if os.path.exists(sd):
        os.remove(sd)  # StageService does not honour overwriteOutput
    try:
        arcpy.server.StageService(sddraft, sd)
    except arcpy.ExecuteError as e:
        # ponytail: the first StageService call in a process fails with 00396 and the second passes; root cause in Pro unknown.
        if "00396" not in str(e):
            raise
        arcpy.server.StageService(sddraft, sd)
    print(f"staged {sd} ({os.path.getsize(sd) / 1e6:.1f} MB)")
    return sd


def upload(sd, service, cfg):
    import arcpy
    from arcgis.gis import GIS
    arcpy.server.UploadServiceDefinition(sd, "My Hosted Services")
    gis = GIS("home")
    hits = gis.content.search(f'title:"{service["name"]}" AND owner:{gis.users.me.username}',
                              item_type="Feature Service", max_items=10)
    item = next(i for i in hits if i.title == service["name"])
    level = {"private": "PRIVATE", "org": "ORGANIZATION", "everyone": "EVERYONE"}[cfg.get("sharing", "org")]
    item.sharing.sharing_level = level
    print(f"uploaded {item.title} ({item.id}) {item.url}, sharing {level}")
    return item


def publish_fgdb(service, cfg, staging_dir, gis=None):
    # Copy the service's layers into one FGDB, zip it, upload it as a File Geodatabase item and publish it.
    # Layer names are the feature class names. With item_id set, the hosted service is overwritten in place.
    import arcpy
    from arcgis.gis import GIS
    gis = gis or GIS("home")
    name = service["name"]
    gdb = common.ensure_gdb(os.path.join(staging_dir, name + ".gdb"))
    arcpy.env.overwriteOutput = True
    for spec in service["layers"]:
        arcpy.management.CopyFeatures(common.repo_path(spec["path"]), os.path.join(gdb, spec["name"]))
    zip_path = os.path.join(staging_dir, name + ".zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:  # arcpy holds *.lock files open while we run
        for fn in os.listdir(gdb):
            if not fn.endswith(".lock"):
                zf.write(os.path.join(gdb, fn), os.path.join(name + ".gdb", fn))
    existing = gis.content.get(service["item_id"]) if service.get("item_id") else None
    if existing:
        from arcgis.features import FeatureLayerCollection
        FeatureLayerCollection.fromitem(existing).manager.overwrite(zip_path)
        item = existing
        print(f"overwrote {item.title} ({item.id}) {item.url}")
    else:
        props = {"title": name, "type": "File Geodatabase", "tags": ",".join(service.get("tags", [])),
                 "snippet": service["summary"], "description": service["description"], "accessInformation": cfg["credits"]}
        folder = cfg["portal_folder"]
        if folder not in {f.name for f in gis.users.me.folders}:
            gis.content.folders.create(folder)
        fgdb = gis.content.folders.get(folder).add(props, file=zip_path).result()
        item = fgdb.publish(publish_parameters={"name": name})
        print(f"published {item.title} ({item.id}) {item.url}; set item_id = \"{item.id}\" in config/publish.toml")
    level = {"private": "PRIVATE", "org": "ORGANIZATION", "everyone": "EVERYONE"}[cfg.get("sharing", "org")]
    item.sharing.sharing_level = level
    return item


def apply_service_aliases(cfg, gis=None):
    # Field aliases on the hosted layers, from config/field_aliases.csv; an overwrite publish resets them, so run after every upload.
    from arcgis.gis import GIS
    gis = gis or GIS("home")
    aliases = common.load_aliases()
    scenarios = common.load_config()["analysis"].get("scenarios", [])
    for s in cfg["services"]:
        if not s.get("item_id"):
            continue
        for lyr in gis.content.get(s["item_id"]).layers:
            fields = []
            for f in lyr.properties.fields:
                alias = common.alias_for(f["name"], aliases, scenarios)
                if alias and f["alias"] != alias:
                    fields.append({"name": f["name"], "alias": alias})
            if fields:
                lyr.manager.update_definition({"fields": fields})
            print(f"{lyr.properties.name}: {len(fields)} aliases updated")


def run(config=CONFIG, aprx_path=None, staging_dir=None, map_only=False, stage_only=False, fgdb=False, aliases_only=False):
    import arcpy
    cfg = load(config)
    if aliases_only:
        return apply_service_aliases(cfg)
    aprx_path = aprx_path or cfg["aprx"]
    staging_dir = os.path.normpath(common.repo_path(staging_dir or cfg["staging_dir"]))
    if fgdb:
        os.makedirs(staging_dir, exist_ok=True)
        return {s["name"]: publish_fgdb(s, cfg, staging_dir) for s in cfg["services"] if s.get("method") == "fgdb"}
    print(f"aprx: {aprx_path}\nstaging: {staging_dir}")
    aprx = arcpy.mp.ArcGISProject(aprx_path)
    m, layers = build_map(aprx, cfg)
    aprx.save()
    if map_only:
        return {}
    pro = [s for s in cfg["services"] if s.get("method") != "fgdb"]
    sds = {s["name"]: stage(m, s, layers[s["name"]], cfg, staging_dir) for s in pro}
    if not stage_only:
        for s in pro:
            upload(sds[s["name"]], s, cfg)
        apply_service_aliases(cfg)
    return sds


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--config", default=CONFIG)
    p.add_argument("--aprx")
    p.add_argument("--staging-dir")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--map-only", action="store_true")
    g.add_argument("--stage-only", action="store_true")
    g.add_argument("--fgdb", action="store_true", help='publish only the services with method = "fgdb"')
    g.add_argument("--aliases-only", action="store_true", help="only push config/field_aliases.csv to the hosted layers")
    a = p.parse_args()
    run(a.config, a.aprx, a.staging_dir, a.map_only, a.stage_only, a.fgdb, a.aliases_only)
