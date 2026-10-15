/**
 * MARC Transportation Resilience Explorer — config registry.
 *
 * The one place a component may learn something schema-shaped. No component
 * names a field, a layer or a section on its own; it either reads it from the
 * live SDK object or from a constant here.
 *
 * What is here:
 *
 * - **Data source** — the web map id (written by `scripts/build_webmap.py`),
 *   and nothing else about its contents.
 * - **Field and layer rules** — which layers are reference-only, which fields to
 *   skip, formatting hints. NOT the catalog's grouping or order.
 * - **Boundary sets** — which web-map layers back the global area filter, and
 *   the field holding each option's name.
 * - **Presentation constants** — basemap gallery list, default view, help
 *   content, attribution.
 *
 * What is deliberately NOT here: the Explore panel's structure. Its sections,
 * their order, the rows inside them and their symbology are all authored in the
 * web map and read at runtime — see "Catalog structure" below.
 */

import webmap from './webmap.json'

/* ── Data sources ─────────────────────────────────────────────────────── */

export const WEB_MAP_ID: string = webmap.webMapId
// Closure depth ladder the scenario layers were run at (config/build.toml via build_webmap.py).
export const THRESHOLDS_FT: number[] = webmap.thresholdsFt
export const DEFAULT_THRESHOLD_FT: number = webmap.defaultThresholdFt

/* ── Catalog structure ────────────────────────────────────────────────────
   The Explore panel's grouping, its order and its symbology are ALL authored in
   the AGOL Map Viewer; none of it is configured here.

   - A group layer holding independent layers is a catalog SECTION, and its
     title is the section name.
   - A group layer with visibilityMode "exclusive" is one catalog ROW, and its
     children are that row's symbolize-by options — each child's title is the
     option label and its renderer is what draws.
   - Order, at every level, is the order the Map Viewer's layer list shows:
     sections, the rows inside them, and the symbology options inside those.

   The only thing left here is where a layer goes when it is in no group at all.
   Seeing this section appear in the app means a layer needs a home in the web
   map — it is a signal, not a category to curate. */

export const UNGROUPED_SECTION = 'Other layers'

/** Scenario story card: the catalog section holding scenario rows, which rows
 *  carry zones and closed segments, and the fields the headline numbers read.
 *  Written by `scripts/run_network_analysis.py` (write_outputs). */
export const SCENARIO_STORY = {
  section: 'Scenarios',
  thresholdField: 'threshold_ft',
  zones: { title: /^stranded zones/i, type: 'zone_type', id: 'zone_id', population: 'population', jobs: 'jobs', facilities: 'facilities', miles: 'miles' },
  closed: { title: /^closed segments/i, id: 'edge_id', detour: 'detour_mi', noDetour: 'no_detour' },
}

// Sections drawn on the Stranded Zones tab; Hazards currently holds only the FEMA fill.
export const ZONES_TAB_SECTIONS = /^(scenarios|hazards|reference)$/i

// Stranded zones CSV column order; matches write_outputs in scripts/run_network_analysis.py.
export const ZONE_FIELDS = ['threshold_ft', 'zone_id', 'zone_type', 'egress_baseline', 'egress_scenario', 'single_egress', 'miles', 'population', 'jobs', 'facilities', 'elderly_share', 'child_share', 'mobility_disab_share']

/** Reference boundary layers de-prioritized on map click (feature detail). */
export const REFERENCE_LAYER_TITLES = /^(counties)$/i

/** Fields never shown or chosen as attributes/headlines. */
export const SKIP_FIELDS = /^(objectid|fid|shape|shape_|shape__|globalid|created_|last_edit)/i
/** Identifier-like fields — never a headline stat, never a percent meter. */
export const ID_LIKE = /(^|_)(id|code|objectid|fid|geoid|guid|key)$|^shape/i
/** Percent-like numeric fields get percent formatting and meters. */
export const PCT_LIKE = /pct|percent|_norm$|ratio|share/i
/** Max symbology choices offered as radios before falling back to a select. */
export const MAX_ATTRIBUTE_RADIOS = 8

/* ── Boundary sets (global area filter) ───────────────────────────────────
   Options are read live from the named web-map layers; nothing is
   hard-coded. `chipLabel` trims the option down for the chip row. */

export interface BoundarySet {
  group: string // menu group header
  layerTitle: string // title of the source layer in the web map
  nameField: string // field holding the option name
  displayField?: string // optional richer label field
}

export const BOUNDARY_SETS: BoundarySet[] = [{ group: 'County', layerTitle: 'Counties', nameField: 'NAME' }]

/** Initial map view — the Kansas City region. Also the reset target when
 *  the area filter clears. */
export const DEFAULT_VIEW = { center: [-94.58, 39.1] as [number, number], zoom: 8 }

/** Basemap gallery contents, in order — 1.0 parity (its Experience Builder map
 *  widget exposed the stock Esri gallery). These are well-known basemap ids the
 *  SDK resolves without a portal query, so the list costs nothing until the
 *  user opens the gallery; their titles and thumbnails come from the SDK. */
export const BASEMAP_IDS = [
  'terrain',
  'topo-vector',
  'streets-vector',
  'streets-navigation-vector',
  'gray-vector',
  'dark-gray-vector',
  'satellite',
  'hybrid',
  'streets-relief-vector',
  'streets-night-vector',
  'oceans',
  'osm',
] as const

/** Which gallery entry the web map's own basemap stands in for. The web map is
 *  built with Light Gray Canvas by `scripts/build_webmap.py`; the app shows that
 *  authored basemap in the `gray-vector` slot rather than a second copy of it.
 *  A stale value only costs the gallery a duplicate row, never a wrong map. */
export const WEB_MAP_BASEMAP_ID = 'gray-vector'

/* ── Help content ─────────────────────────────────────────────────────── */

export const HELP = {
  links: [
    {
      label: 'Mid-America Regional Council — Transportation',
      href: 'https://www.marc.org/transportation',
    },
    {
      label: 'Application source code',
      href: 'https://github.com/high-street-consulting/marc-resiliency-study',
    },
    // Built from the id above rather than repeated, so a web map cannot be
    // swapped in the registry and left mis-linked here.
    {
      label: 'Data layers web map',
      href: `https://www.arcgis.com/home/item.html?id=${WEB_MAP_ID}`,
      note: 'Every layer, its symbology and its grouping are authored here',
    },
  ],
  description:
    'The Transportation Resilience Explorer supports the Mid-America Regional Council’s Transportation Resilience Phase 2 study, which assesses how the Kansas City region’s roadway network and bridges hold up to flooding and other hazards. This Explorer module browses the study’s data layers — turn layers on, choose which attribute is symbolized, and filter by county or attribute. The Stranded Zones tab opens the flood scenario view: closed segments, cut-off zones and a closure depth to vary. It holds the scenario and closure-depth controls, the headline numbers, the ranked zone list and the CSV and report exports. Project scoring follows in a later phase.',
}

export const ATTRIBUTION =
  'Data published by the Mid-America Regional Council (MARC) and partner agencies for the Transportation Resilience Phase 2 study. Prototype by High Street.'
