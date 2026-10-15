# Build inputs

Every input the Phase 2 network build reads, with source, vintage, download date and cost. To rebuild the downloaded inputs, run `scripts/download_inputs.py` with the ArcGIS Pro Python (see `notebooks/00_download_inputs.ipynb`). Paths are set in `config/build.toml`.

| Input | Source URL | Vintage | Downloaded | Cost | Local path |
|---|---|---|---|---|---|
| OSM Kansas extract | https://download.geofabrik.de/north-america/us/kansas-261012.osm.pbf (from `kansas-latest`) | Geofabrik extract 2026-10-12 (Last-Modified 2026-10-13 01:28 GMT), md5 `11b30037fcf35027b3f86a339ccaefb8` | 2026-10-13 | Free (ODbL, credit OpenStreetMap) | `data/downloads/geofabrik/kansas-261012.osm.pbf` |
| OSM Missouri extract | https://download.geofabrik.de/north-america/us/missouri-261012.osm.pbf (from `missouri-latest`) | Geofabrik extract 2026-10-12, md5 `595f4e85090ab2a0003df0446046b18f` | 2026-10-13 | Free (ODbL) | `data/downloads/geofabrik/missouri-261012.osm.pbf` |
| HPMS 2024, Kansas | https://geo.dot.gov/server/rest/services/Hosted/HPMS_FULL_KS_2024/FeatureServer/0 (FHWA public release, item 9b4919547cf34c37bf1ac6d4f67a0b01) | Data year 2024, submitted 2025 | 2026-10-13 | Free | `data/downloads/hpms/hpms_2024.gdb/HPMS_FULL_KS_2024` (45,764 sections) |
| HPMS 2024, Missouri | https://geo.dot.gov/server/rest/services/Hosted/HPMS_FULL_MO_2024/FeatureServer/0 (item f4beed18c074453f94967618eae18dd1) | Data year 2024 | 2026-10-13 | Free | `data/downloads/hpms/hpms_2024.gdb/HPMS_FULL_MO_2024` (163,111 sections) |
| ACS 5-year B01001 (sex by age), tracts | https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/acsdt5y2024-b01001.dat | 2020-2024 ACS 5-year | 2026-10-13 | Free | `data/downloads/acs/acs5_2024_b01001_tracts.csv` (584 tracts in the nine counties) |
| Delivered Phase 2 gdb (bridges_nbi, traffic_counts_kdot_county_city, pavement_condition_*, county_boundaries, cdc_places_health, population_forecast_tract, criticality point layers, HAZ tables) | Project OneDrive delivery, 2026-10-13 | As documented per layer (`data_source`, `source_note`) | 2026-10-13 | Project data | `data/OneDrive_1_10-13-2026/MARC_Resilience_Phase2_gdb/MARC_Resilience_Phase2.gdb` |
| Fathom US Flood Model depths | Purchased for the project (Task 3.2 Track A, nine counties); not yet received | Project-only snapshot | n/a | Paid, project-only licence (see Fathom note below) | to be keyed to `edge_id` on delivery |
| FEMA NFHL flood hazard zones, nine MARC counties (S_FLD_HAZ_AR, SFHA_TF = T, the 1% annual chance floodplain) | Esri Living Atlas USA Flood Hazard Areas (item ccd29fb4bd5e4b44a2d61638829a5d7e, NFHL snapshot of March 3, 2026), https://services5.arcgis.com/7weheFjxuNkGGiZi/arcgis/rest/services/USA_Flood_Hazard_Areas_view/FeatureServer/0, one query per DFIRM_ID (county GEOID + C). FEMA's own server (hazards.fema.gov NFHL MapServer/28) returns 500 on county-size geometry queries; its per-county counts match the mirror within 0.3% | NFHL as served 2026-10-14 | 2026-10-14 | Free (Esri Master License Agreement; source FEMA) | `data/downloads/fema/nfhl.gdb/nfhl_sfha` (11,520 polygons, WGS84, pulled from the now-deprecated Reduced Set item 2b245b7f816044d7a779a61a5844be23; the current item holds 11,530 for the same counties). Closure input for the `fema_1pct` method-test scenario via `scripts/fema_closures.py` |

## Notes on the downloads

- **OSM format.** Geofabrik no longer publishes `.osm.bz2` XML for US states (checked 2026-10-13: `kansas-latest.osm.bz2` and `missouri-latest.osm.bz2` return 404; the state pages list only `.osm.pbf`, shapefile and GeoPackage). The build therefore reads the PBFs with a stdlib + numpy reader in `scripts/build_osm_graph.py`, using zlib and a minimal protobuf decoder in two passes: highway ways first, then only the nodes those ways use. Ways that appear in both state extracts are kept once by `osm_id`. If pyosmium is installed, `read_ways` uses it instead.

- **HPMS format.** The 2024 public release is not one shapefile per data item. FHWA publishes one wide polyline layer per state ("full intersection": every item as a column, sections already split wherever any item changes), only as a query-only feature service. The FHWA shapefile page still offers 2018 only. The build derives one event table per item (`ev_<item>`) from the wide layer, so the per-item design of the plan holds.
- **HPMS extent.** Only sections intersecting the envelope -95.25, 38.33, -93.70, 39.60 (the nine counties plus about 5 km) were downloaded. Scored sections are split at the county boundary and only the part inside the study area is kept.
- **ACS.** The Census API now requires a key, so the build reads the table-based summary file instead (one national file, filtered to the nine counties). Under 18 = B01001 E003-E006 + E027-E030; 65 and over = E020-E025 + E044-E049.
- **Fathom.** Paid for this project only, and not part of the tool going forward. Stranded-zone results are a dated snapshot. Scenario runs take their return period, year, SSP and depth threshold from `config/build.toml`, so MARC can re-run with other depth data.

## Coordinate system

Built layers use NAD 83 State Plane Missouri West, US feet (WKID 102698), set in `config/build.toml` `[crs] wkid`. The plan text gave WKID 102697, but that is Missouri **Central**. Confirm feet vs meters with MARC GIS.

## Method notes

- Phase 1 (CS, April 2025) used the MARC travel demand model for disruption impacts. Phase 2 uses the OSM graph instead, with detour length as the proxy. Scenario detours run on the flooded graph. The baseline `redundancy_detour_mi` is the shortest surviving path when a single Tier 1 edge is removed, bounded by `redundancy_cutoff_mi`.
- On divided highways, HPMS holds AADT only on the inventory-direction route (Facility_Type 2). Non-inventory-direction sections (Facility_Type 6) carry no AADT.
- Linkage locates edge points on `hpms_routes` with an in-process `scipy.spatial.cKDTree`. Route vertices are densified to 10 m, and each point is projected exactly onto the candidate segments; this replaced `LocateFeaturesAlongRoutes`. A one-way edge on a directional route (Facility_Type 1 or 6) prefers the route whose measure increases in its direction of travel, but this is not required. Some non-inventory routes, for example KS I-435, are measured against the direction of travel.
- `redundancy_no_path = 1` is common on one-way carriageways and ramps. A node in the middle of a one-way chain has no other way out once the edge is removed, so these flags mostly reflect the chain, not missing network redundancy.
