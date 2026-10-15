/**
 * MapController — owns the app's single MapView and the MARC web map it
 * draws (`WEB_MAP_ID`, written by `scripts/build_webmap.py`).
 *
 * Symbology is authored entirely in the ArcGIS Online Map Viewer. A layer
 * that offers more than one symbology is a GroupLayer with
 * `visibilityMode: "exclusive"` whose children are one feature layer per
 * option, each carrying its own renderer; the child's title is the option
 * label. The app holds no layer, field, or renderer knowledge of its own —
 * the catalog is derived from whatever the web map contains.
 *
 * Components talk to this controller, never to the SDK directly.
 *
 * ## Sections in this file, in order
 *
 * | Section | What it owns |
 * |---|---|
 * | Lifecycle | `init()`, the view, its widgets |
 * | Layer parking | keeping layers that aren't drawing OUT of the map |
 * | Lazy layer metadata | loading a layer's own fields only when needed |
 * | Catalog | deriving catalog rows from the web map; syncing back from the SDK |
 * | Feature click / hover | Explore's map interactions |
 * | Boundaries & area filter | the global area filter, applied per layer view |
 * | Custom area sketch / upload | draw or upload an area to filter by |
 * | Basemap gallery, Legend | map chrome |
 *
 * ## Two rules this file exists to enforce
 *
 * 1. **A MapView loads EVERY layer in its map, visible or not.** So the map
 *    holds only what is drawing — see "Layer parking". Ignoring this cost ~400
 *    startup requests.
 * 2. **Never assume a visibility write took effect.** Exclusive group layers
 *    mutate sibling visibility themselves and refuse some writes outright, so
 *    state is always re-read from the SDK (`syncFromSdk`) after mutating.
 */

import WebMap from '@arcgis/core/WebMap'
import MapView from '@arcgis/core/views/MapView'
import Home from '@arcgis/core/widgets/Home'
import FeatureLayer from '@arcgis/core/layers/FeatureLayer'
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer'
import Graphic from '@arcgis/core/Graphic'
import FeatureFilter from '@arcgis/core/layers/support/FeatureFilter'
import SketchViewModel from '@arcgis/core/widgets/Sketch/SketchViewModel'
import * as geometryEngine from '@arcgis/core/geometry/geometryEngine'
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils'
import Legend from '@arcgis/core/widgets/Legend'
import Search from '@arcgis/core/widgets/Search'
import Locate from '@arcgis/core/widgets/Locate'
import Basemap from '@arcgis/core/Basemap'
import BasemapGallery from '@arcgis/core/widgets/BasemapGallery'
import Expand from '@arcgis/core/widgets/Expand'
import * as reactiveUtils from '@arcgis/core/core/reactiveUtils'
import type Geometry from '@arcgis/core/geometry/Geometry'
import type Field from '@arcgis/core/layers/support/Field'
import type GroupLayer from '@arcgis/core/layers/GroupLayer'
import Polygon from '@arcgis/core/geometry/Polygon'

import {
  WEB_MAP_ID,
  UNGROUPED_SECTION,
  SKIP_FIELDS,
  BOUNDARY_SETS,
  BASEMAP_IDS,
  WEB_MAP_BASEMAP_ID,
  REFERENCE_LAYER_TITLES,
  DEFAULT_VIEW,
  SCENARIO_STORY,
  DEFAULT_THRESHOLD_FT,
  ZONES_TAB_SECTIONS,
} from '../config/registry'

/** One symbology choice — a child of an exclusive group layer. The child's
 *  title, authored in the Map Viewer, is the label the user reads. */
export interface SymbologyOption {
  /** The child FeatureLayer's id. */
  id: string
  label: string
  layer: FeatureLayer
}

export interface CatalogEntry {
  /** GroupLayer id for a symbology group, FeatureLayer id for a plain layer. */
  id: string
  title: string
  section: string
  meta: string
  /** The layer currently drawing: a group's visible child, or the plain layer. */
  layer: FeatureLayer
  on: boolean
  geometry: string
  /** Field this layer's own renderer symbolizes — drives the attribute filter
   *  and the feature-detail headline. Read live off the renderer, never config. */
  filterField: string | null
  /** Set when this entry is an exclusive group layer; null for a plain layer. */
  groupId: string | null
  /** The group's children in authored order. Empty for a plain layer. */
  symbologies: SymbologyOption[]
  /** Id of the visible child, mirrored from the SDK. Null for a plain layer. */
  activeSymbology: string | null
  /** The child the web map authored visible, captured at load. What a share
   *  link compares against, so it only carries a symbology the user changed. */
  defaultSymbology: string | null
  /** False until the drawing layer's own service metadata (fields, geometry,
   *  portal item) has resolved. The row is listed either way — detail that
   *  needs the service fills in when it arrives. */
  ready: boolean
}

export interface SelectedFeature {
  layerTitle: string
  attrs: Record<string, unknown>
  fields: Field[]
  geometry: Geometry | null
  layer: FeatureLayer
}

export interface BoundaryOption {
  group: string
  name: string
  display: string
}

type Events = {
  layers: CatalogEntry[]
  layersError: string
  mapError: string
  selected: SelectedFeature | null
  hover: { title: string; x: number; y: number } | null
  boundaries: BoundaryOption[]
  areaGeometry: Geometry | null
  sketchActive: boolean
  threshold: number | null
}

type Listener<K extends keyof Events> = (v: Events[K]) => void

export class MapController {
  container: HTMLDivElement
  private view: MapView | null = null
  private webmap: WebMap | null = null
  private sketchLayer = new GraphicsLayer({ listMode: 'hide', title: 'Selection' })
  private sketch: SketchViewModel | null = null
  private listeners: Partial<Record<keyof Events, Set<(v: never) => void>>> = {}

  entries: CatalogEntry[] = []
  boundaries: BoundaryOption[] = []

  private areaGeometry: Geometry | null = null
  private hoverLast = 0
  private boundaryGeomCache = new Map<string, Geometry>()
  /** Exclusive group layers backing grouped catalog entries, by entry id. */
  private groups = new Map<string, GroupLayer>()
  /** The group layer behind each catalog SECTION, by section name. */
  private sectionGroups = new Map<string, GroupLayer>()
  /** Sections collapsed in the catalog. A collapsed section draws nothing: the
   *  panel is the map's legend, so what is out of sight is off the map. */
  private closedSections = new Set<string>()
  /** Active attribute filter per catalog entry — replayed onto a group's
   *  newly visible child so switching symbology never drops the filter. */
  private defExpr = new Map<string, string>()
  // Closure depth (ft) the scenario rows are filtered to; ANDed onto their attribute filter.
  private thresholdFt: number | null = null
  private groupWatches: { remove(): void }[] = []
  private legend: Legend | null = null
  private legendEl: HTMLDivElement | null = null
  private pendingLegendTarget: HTMLElement | null = null
  private tab: 'explore' | 'zones' = 'explore'
  private pendingZoom: Geometry | null = null

  constructor() {
    this.container = document.createElement('div')
    this.container.style.cssText = 'position:absolute;inset:0'
    // The map canvas is an enhancement over the data panels, not the only
    // route to the data; mark it for AT and keyboard users accordingly.
    this.container.setAttribute('role', 'application')
    this.container.setAttribute('aria-label', 'Map. Data shown here is also available in the attribute table.')
  }

  /** Subscribe to a controller event; returns an unsubscribe function. This is
   *  the only channel from the map back into React — App wires every listener
   *  once on mount. */
  on<K extends keyof Events>(ev: K, fn: Listener<K>): () => void {
    const set = (this.listeners[ev] ??= new Set()) as unknown as Set<Listener<K>>
    set.add(fn)
    return () => set.delete(fn)
  }

  private emit<K extends keyof Events>(ev: K, v: Events[K]) {
    ;(this.listeners[ev] as unknown as Set<Listener<K>> | undefined)?.forEach((fn) => fn(v))
  }

  /* ── Lifecycle ── */

  private initPromise: Promise<void> | null = null

  init(): Promise<void> {
    return (this.initPromise ??= this.doInit())
  }

  private async doInit(): Promise<void> {
    if (this.view) return
    // No id until scripts/build_webmap.py has run: draw the basemap alone.
    const webmap = new WebMap(WEB_MAP_ID ? { portalItem: { id: WEB_MAP_ID } } : { basemap: WEB_MAP_BASEMAP_ID })
    this.webmap = webmap

    if (!WEB_MAP_ID) this.emit('layersError', 'No web map configured — run scripts/build_webmap.py')
    else
      try {
        // load(), never loadAll(). The web map's own item JSON already names
        // every layer, every group child, their visibility and their authored
        // renderer, so one round trip builds the whole catalog. loadAll() would
        // additionally fetch service and portal-item metadata for every leaf
        // layer, nearly all of them for symbology options the user has not
        // asked to see. Each layer loads on first use instead.
        await webmap.load()
      } catch (err) {
        this.emit('layersError', errMsg(err, 'The web map is not publicly shared, so its layer list cannot be read.'))
      }

    // Build (and park down to what is drawing) BEFORE the view exists: a
    // MapView loads every layer its map contains, so the map must be lean by
    // the time one is attached to it.
    this.buildCatalog()
    this.setThreshold(DEFAULT_THRESHOLD_FT)

    webmap.add(this.sketchLayer)

    const view = new MapView({
      container: this.container,
      map: webmap,
      center: DEFAULT_VIEW.center,
      zoom: DEFAULT_VIEW.zoom,
      padding: { top: 0, right: 0, bottom: 8, left: 0 },
      popupEnabled: false,
      ui: { components: ['zoom'] },
    })
    this.view = view
    // Zoom sits bottom-right (Google Maps convention) so the top-left is
    // free for search and the top-right for home/locate.
    view.ui.move('zoom', 'bottom-right')
    view.ui.add(new Home({ view }), 'top-right')
    // v1 parity: address search, basemap gallery, and find-my-location
    view.ui.add(new Search({ view, popupEnabled: false, resultGraphicEnabled: true }), 'top-left')
    view.ui.add(this.makeBasemapExpand(view), 'top-left')
    view.ui.add(new Locate({ view }), 'top-right')
    // The legend mount may have arrived while the web map was still loading.
    if (this.pendingLegendTarget) {
      const target = this.pendingLegendTarget
      this.pendingLegendTarget = null
      this.attachLegend(target)
    }

    this.loadBoundaries()

    view
      .when(() => {
        view.on('click', (ev: any) => this.handleClick(ev))
        view.on('pointer-move', (ev: any) => this.handleHover(ev))
      })
      .catch((err: unknown) =>
        this.emit('mapError', errMsg(err, 'This web map could not be opened. It may not be shared publicly.')),
      )

    this.sketch = new SketchViewModel({
      view,
      layer: this.sketchLayer,
      defaultUpdateOptions: { tool: 'reshape' },
      polylineSymbol: {
        type: 'simple-line',
        color: '#b30838',
        width: 2.5,
        style: 'short-dash',
      } as any,
      polygonSymbol: {
        type: 'simple-fill',
        color: [179, 8, 56, 0.08],
        outline: { color: '#b30838', width: 1.6, style: 'short-dash' },
      } as any,
      pointSymbol: {
        type: 'simple-marker',
        style: 'circle',
        color: '#b30838',
        size: 9,
        outline: { color: '#fff', width: 1.5 },
      } as any,
    })
  }

  setTab(tab: 'explore' | 'zones'): void {
    this.tab = tab
    this.applyTabVisibility()
    // Layers that just joined the map need the area filter re-asserted.
    void this.applyFilters()
    const g = this.pendingZoom
    if (g) {
      this.pendingZoom = null
      requestAnimationFrame(() => this.zoomTo(g, true))
    }
  }

  queueZoom(g: Geometry | null): void {
    this.pendingZoom = g
  }

  /** Move the map canvas into a mount point. */
  attach(target: HTMLElement | null): void {
    if (!target) return
    if (this.container.parentNode !== target) target.appendChild(this.container)
  }

  /** Draw what the catalog says should draw.
   *
   *  Hide and restore at the GROUP level. A group with visibilityMode
   *  "exclusive" refuses to hide its last visible child, and restoring
   *  children one by one would re-trigger the exclusive auto-hide and could
   *  resurrect the wrong sibling. Hiding the group hides the whole subtree and
   *  leaves the child selection untouched. */
  private applyTabVisibility(): void {
    for (const e of this.entries) {
      const target = e.on
      const group = e.groupId ? this.groups.get(e.groupId) : null
      if (group) group.visible = target
      else if (e.layer) e.layer.visible = target
    }
    // A section group gates everything beneath it, so a collapsed section draws
    // nothing regardless of what its rows say — and re-expanding restores them
    // untouched, because hiding the parent never rewrites a child's own
    // visibility. The zones tab hides sections here too, never row groups:
    // syncFromSdk reads a row group's own `visible`, so Explore's rows survive.
    for (const [name, group] of this.sectionGroups)
      group.visible = this.tab === 'zones' ? ZONES_TAB_SECTIONS.test(name) : !this.closedSections.has(name)
  }

  /** Tell the controller which catalog sections are expanded. Collapsing a
   *  section hides its layers; the catalog is the map's legend, so a layer the
   *  user cannot see listed should not be drawing. */
  setOpenSections(open: Iterable<string>): void {
    const openSet = new Set(open)
    const next = new Set([...this.sectionGroups.keys()].filter((n) => !openSet.has(n)))
    const changed =
      next.size !== this.closedSections.size || [...next].some((n) => !this.closedSections.has(n))
    if (!changed) return
    this.closedSections = next
    this.applyTabVisibility()
  }

  /* ── Layer parking ──
     A MapView creates a LayerView — and so loads the service metadata and the
     portal item — for EVERY layer its map contains, visible or not. With
     symbology authored as exclusive groups that is 79 leaf layers and ~400
     requests before anything is interactive, nearly all of them for symbology
     options nobody asked to see. So the map holds only what is drawing: a row
     that is off lives outside the map, and a group holds only its chosen
     child. Parked layers keep their identity, so the catalog rows, the URL
     state, the definition expressions and every watch still address them. */

  /** Authored sibling order per container, so an unparked layer returns to
   *  the position the Map Viewer gave it instead of on top of the stack. */
  private authoredOrder = new Map<LayerContainer, string[]>()
  /** The layer the map holds for each catalog row, and who owns it. */
  private rowNodes = new Map<string, { node: MapLayer; container: LayerContainer }>()
  private parkedLayers = new Set<string>()

  private recordOrder(container: LayerContainer): void {
    this.authoredOrder.set(
      container,
      toArray(container.layers).map((l) => String(l.id)),
    )
  }

  private park(container: LayerContainer | null | undefined, layer: MapLayer | null | undefined): void {
    if (!container || !layer) return
    if (toArray(container.layers).includes(layer)) container.layers.remove(layer)
    this.parkedLayers.add(String(layer.id))
  }

  private unpark(container: LayerContainer | null | undefined, layer: MapLayer | null | undefined): void {
    if (!container || !layer) return
    this.parkedLayers.delete(String(layer.id))
    const present = toArray(container.layers)
    if (present.includes(layer)) return
    // Slot it back in among whichever siblings are currently attached, so
    // draw order still follows the web map rather than the click order.
    const order = this.authoredOrder.get(container) ?? []
    const want = order.indexOf(String(layer.id))
    let at = 0
    present.forEach((l, i) => {
      const pos = order.indexOf(String(l.id))
      if (pos !== -1 && pos < want) at = i + 1
    })
    container.layers.add(layer, at)
  }

  /* ── Lazy layer metadata ── */

  /** Layer ids whose service metadata load is in flight. */
  private loadingLayers = new Set<string>()
  private emitTimer = 0

  /** Coalesce the re-emits that lazy loads trigger: several layers resolving
   *  in the same turn are one catalog update, not one each. */
  private scheduleEmit(): void {
    if (this.emitTimer) return
    this.emitTimer = window.setTimeout(() => {
      this.emitTimer = 0
      this.syncFromSdk()
      this.emit('layers', [...this.entries])
    }, 0)
  }

  /** Pull one layer's own metadata, once. Nothing loads at startup: the row,
   *  its title and its symbology list all come from the web map JSON. Fields,
   *  geometry type and the portal-item description arrive the first time the
   *  row is switched on, symbolized, or its metadata disclosure is opened. */
  private ensureLoaded(layer: FeatureLayer | null | undefined): void {
    if (!layer || layer.loaded) return
    const key = String(layer.id)
    if (this.loadingLayers.has(key)) return
    this.loadingLayers.add(key)
    const done = () => {
      this.loadingLayers.delete(key)
      this.scheduleEmit()
    }
    layer.load().then(done, done)
  }

  /** Ask for a row's detail (field count, description, filterable fields)
   *  ahead of turning it on — the catalog's info disclosure calls this. */
  loadEntryDetail(id: string): void {
    const e = this.entries.find((x) => x.id === id)
    if (e) this.ensureLoaded(e.layer)
  }

  /* ── Catalog ── */

  /** Derive the whole catalog from the loaded web map — no layer, field or
   *  renderer is named in code. An exclusive group layer is ONE catalog row
   *  whose symbology choices are its children; any other group contributes
   *  its children as independent rows and lends them its title as a section. */
  private buildCatalog(): void {
    const map = this.webmap
    if (!map) return
    this.groups.clear()
    this.sectionGroups.clear()
    for (const w of this.groupWatches) w.remove()
    this.groupWatches = []
    // An exclusive group is a LAYER, not a section: only a group holding
    // independent layers names a section, and its title IS the section. A layer
    // in no group at all has no section to inherit and falls to
    // UNGROUPED_SECTION, which is a prompt to give it a home in the web map.
    const sectionOf = (sectionTitle: string | null): string => sectionTitle ?? UNGROUPED_SECTION
    // Dedupe on layer id, never on title: sibling symbologies across groups
    // legitimately share titles ("Daily Volume 2050", "Project Type"), and a
    // title-keyed guard would silently discard them.
    const seen = new Set<string>()
    const entries: CatalogEntry[] = []

    const prepare = (fl: FeatureLayer) => {
      try {
        fl.outFields = ['*']
      } catch {
        /* not all layers accept it */
      }
    }
    const emitGroup = (g: GroupLayer, sectionTitle: string | null, container: LayerContainer) => {
      const id = String(g.id)
      if (seen.has(id)) return
      const kids = [...childLayers(g)].reverse()
      if (!kids.length) return
      seen.add(id)
      this.recordOrder(g)
      this.rowNodes.set(id, { node: g, container })
      for (const c of kids) {
        seen.add(String(c.id))
        prepare(c)
      }
      this.groups.set(id, g)
      const title = g.title ?? 'Layer'
      // Exactly one child is authored visible; fall back to the first.
      const active = kids.find((c) => !!c.visible) ?? kids[0]
      entries.push({
        id,
        title,
        section: sectionOf(sectionTitle),
        geometry: (active.geometryType as string) ?? 'polyline',
        filterField: rendererField(active.renderer),
        meta: metaFields(active),
        layer: active,
        on: !!g.visible,
        groupId: id,
        symbologies: kids.map((c) => ({ id: String(c.id), label: c.title ?? 'Symbology', layer: c })),
        activeSymbology: String(active.id),
        defaultSymbology: String(active.id),
        ready: !!active.loaded,
      })
      this.watchGroup(g)
    }

    const walk = (container: LayerContainer, sectionTitle: string | null) => {
      this.recordOrder(container)
      // Snapshot the collection: parking mutates it, so nothing may be
      // removed while the walk is still reading it.
      //
      // Reversed, because a web map's layer array runs bottom-to-top (index 0
      // draws lowest) while the Map Viewer's layer list — the thing actually
      // being authored — reads top-down. Emitting in list order makes the
      // catalog's order, at every level, the order the author sees. Note this
      // couples catalog order to DRAW order: they are one list in a web map.
      // `recordOrder` above deliberately keeps the true array order, which is
      // what parking restores a layer's draw position from.
      ;[...toArray(container.layers)].reverse().forEach((l: any) => {
        if (l.type === 'group') {
          if (l.visibilityMode === 'exclusive') emitGroup(l as GroupLayer, sectionTitle, container)
          else {
            if (l.title) this.sectionGroups.set(l.title, l as GroupLayer)
            walk(l as LayerContainer, l.title ?? sectionTitle)
          }
          return
        }
        if (l.type !== 'feature') return
        const fl = l as FeatureLayer
        const id = String(fl.id)
        if (seen.has(id)) return
        seen.add(id)
        this.rowNodes.set(id, { node: fl, container })
        prepare(fl)
        const title = fl.title ?? 'Layer'
        entries.push({
          id,
          title,
          section: sectionOf(sectionTitle),
          geometry: (fl.geometryType as string) ?? 'polyline',
          filterField: rendererField(fl.renderer),
          meta: metaFields(fl),
          layer: fl,
          on: !!fl.visible,
          groupId: null,
          symbologies: [],
          activeSymbology: null,
          defaultSymbology: null,
          ready: !!fl.loaded,
        })
      })
    }
    walk(map as unknown as LayerContainer, null)
    this.entries = entries
    // Park everything nothing is drawing, before a view can go and load it.
    for (const e of entries) {
      const group = e.groupId ? this.groups.get(e.groupId) : null
      if (group) for (const s of e.symbologies) if (s.id !== e.activeSymbology) this.park(group, s.layer)
      if (!e.on) {
        const row = this.rowNodes.get(e.id)
        this.park(row?.container, row?.node)
      }
    }
    // Collapsed sections draw nothing.
    this.applyTabVisibility()
    this.emit('layers', [...entries])
    // Whatever the web map authored visible is about to draw, so its own
    // metadata is wanted now — the filter reads its fields.
    for (const e of entries) if (e.on) this.ensureLoaded(e.layer)
  }

  /** Mirror the SDK's own visibility state back onto the catalog. Exclusive
   *  groups mutate sibling visibility behind our back (and refuse some writes
   *  outright), so nothing may assume a write took effect. */
  private syncFromSdk(): void {
    for (const e of this.entries) {
      if (e.groupId) {
        const g = this.groups.get(e.groupId)
        if (!g) continue
        e.on = !!g.visible
        // Child visibility survives the group being hidden, so the selected
        // symbology stays readable.
        const opt =
          e.symbologies.find((s) => !!s.layer.visible) ??
          e.symbologies.find((s) => s.id === e.activeSymbology) ??
          e.symbologies[0]
        if (!opt) continue
        e.activeSymbology = opt.id
        e.layer = opt.layer
      } else {
        e.on = !!e.layer.visible
      }
      // Service metadata arrives lazily, so re-read it off whichever layer is
      // drawing now — an unloaded layer simply keeps the placeholders.
      e.geometry = (e.layer.geometryType as string) ?? e.geometry
      e.filterField = rendererField(e.layer.renderer)
      e.meta = metaFields(e.layer)
      e.ready = !!e.layer.loaded
    }
  }

  private watchGroup(g: GroupLayer): void {
    try {
      const handle = reactiveUtils.watch(
        () => [g.visible, ...childLayers(g).map((c) => !!c.visible)].join(','),
        () => {
          this.syncFromSdk()
          this.emit('layers', [...this.entries])
        },
      )
      this.groupWatches.push(handle)
    } catch {
      /* watching is an optimization; the explicit syncs still cover us */
    }
  }

  /** Every feature layer an entry owns — a group's children, or the layer. */
  private layersOf(e: CatalogEntry): FeatureLayer[] {
    return e.symbologies.length ? e.symbologies.map((s) => s.layer) : [e.layer]
  }

  /** Resolve a raw FeatureLayer id (e.g. from a map click) to its catalog row. */
  entryForLayerId(layerId: string | null | undefined): CatalogEntry | undefined {
    if (!layerId) return undefined
    return this.entries.find(
      (e) => e.id === layerId || String(e.layer.id) === layerId || e.symbologies.some((s) => s.id === layerId),
    )
  }

  setLayerVisible(id: string, on: boolean): void {
    const e = this.entries.find((x) => x.id === id)
    if (!e) return
    e.on = on
    const row = this.rowNodes.get(e.id)
    // A row being switched on rejoins the map, and is about to draw and to
    // offer a filter — the moment its own fields are worth a round trip.
    if (on) {
      this.unpark(row?.container, row?.node)
      this.ensureLoaded(e.layer)
    }
    const group = e.groupId ? this.groups.get(e.groupId) : null
    // Never hide a group by hiding its children: an exclusive group snaps
    // the last visible child back on. Toggle the group itself.
    if (group) group.visible = on
    else e.layer.visible = on
    // The global area filter is applied per layer view, so a layer that was
    // parked when the area was picked has to be told about it on the way in.
    if (on) void this.applyAreaFilterTo(e, e.layer)
    else this.park(row?.container, row?.node)
    this.syncFromSdk()
    this.emit('layers', [...this.entries])
  }

  /** Pick a symbology — i.e. make one child of an exclusive group visible.
   *  Both children are momentarily in the group so the SDK's own exclusive
   *  mode does the hiding; only then does the outgoing one leave the map. */
  setSymbology(id: string, optionId: string): void {
    const e = this.entries.find((x) => x.id === id)
    if (!e) return
    const opt = e.symbologies.find((s) => s.id === optionId)
    if (!opt) return // unknown option (e.g. a stale share link) — ignore
    // The newly chosen child carries its own fields and range for the filter.
    this.ensureLoaded(opt.layer)
    const group = e.groupId ? this.groups.get(e.groupId) : null
    this.unpark(group, opt.layer)
    opt.layer.visible = true
    if (group)
      for (const s of e.symbologies)
        if (s.id !== opt.id) {
          s.layer.visible = false
          this.park(group, s.layer)
        }
    // definitionExpression is per-layer, so the active attribute filter has to
    // follow the switch or it would silently vanish off the map.
    if (this.defExpr.has(e.id) || e.section === SCENARIO_STORY.section) {
      try {
        opt.layer.definitionExpression = this.whereFor(e)
      } catch {
        /* immutable layer */
      }
    }
    void this.applyAreaFilterTo(e, opt.layer)
    this.syncFromSdk()
    this.emit('layers', [...this.entries])
  }

  /** Apply the catalog's attribute filter to a row, as a SQL where clause.
   *  Fanned out across every sibling symbology so the filter survives a
   *  symbology switch, and remembered so it can be replayed onto whichever
   *  child is unparked next. Pass null to clear. */
  setDefinitionExpression(id: string, where: string | null): void {
    const e = this.entries.find((x) => x.id === id)
    if (!e) return
    this.defExpr.set(e.id, where ?? '')
    this.applyWhere(e)
  }

  // Scenario layers hold every depth step, so an empty clause would stack them.
  private whereFor(e: CatalogEntry): string {
    const parts = [this.defExpr.get(e.id) ?? '']
    if (e.section === SCENARIO_STORY.section && this.thresholdFt !== null)
      parts.push(`${SCENARIO_STORY.thresholdField} = ${this.thresholdFt}`)
    return parts.filter(Boolean).map((p) => `(${p})`).join(' AND ')
  }

  private applyWhere(e: CatalogEntry): void {
    const w = this.whereFor(e)
    // Fan out across every sibling so the filter survives a symbology switch.
    for (const layer of this.layersOf(e)) {
      try {
        layer.definitionExpression = w
      } catch {
        /* immutable layer */
      }
    }
  }

  get threshold(): number | null {
    return this.thresholdFt
  }

  setThreshold(v: number): void {
    this.thresholdFt = v
    for (const e of this.entries) if (e.section === SCENARIO_STORY.section) this.applyWhere(e)
    this.emit('threshold', v)
  }

  /* ── Feature click / hover (Explore) ── */

  private handleClick(ev: any): void {
    const view = this.view
    if (!view) return
    view.hitTest(ev).then((res) => {
      const cands = (res.results as any[]).filter(
        (r) => r.type === 'graphic' && !!r.graphic?.attributes && r.graphic.layer?.type === 'feature',
      )
      const rich = cands.filter((r) => !REFERENCE_LAYER_TITLES.test(r.graphic.layer?.title ?? ''))
      const hit =
        rich.sort(
          (a: any, b: any) => Object.keys(b.graphic.attributes).length - Object.keys(a.graphic.attributes).length,
        )[0] ?? cands[0]
      if (!hit) {
        this.emit('selected', null)
        return
      }
      const g = hit.graphic
      this.emit('selected', this.toSelected(g.layer as FeatureLayer, g))
    })
  }

  selectFeature(layer: FeatureLayer, g: Graphic): void {
    this.emit('selected', this.toSelected(layer, g))
  }

  private toSelected(fl: FeatureLayer, g: Graphic): SelectedFeature {
    // A hit on a symbology group's child carries the child's title (the
    // option label); the user knows the layer by the group's title.
    return {
      layerTitle: this.entryForLayerId(String(fl.id))?.title ?? fl.title ?? 'Feature',
      attrs: g.attributes as Record<string, unknown>,
      fields: fl.fields ?? [],
      geometry: g.geometry ?? null,
      layer: fl,
    }
  }

  private handleHover(ev: any): void {
    const view = this.view
    if (!view) return
    const now = Date.now()
    if (now - this.hoverLast < 120) return
    this.hoverLast = now
    view.hitTest(ev).then((res) => {
      const hit = (res.results as any[]).find(
        (r) =>
          r.type === 'graphic' &&
          r.graphic?.layer?.type === 'feature' &&
          !REFERENCE_LAYER_TITLES.test(r.graphic.layer?.title ?? ''),
      )
      if (!hit) {
        this.emit('hover', null)
        return
      }
      const g = hit.graphic
      const attrs = g.attributes as Record<string, unknown>
      const nameKey = Object.keys(attrs).find(
        (k) => /name|route|street|road|corridor|project|title|label/i.test(k) && typeof attrs[k] === 'string',
      )
      const title = nameKey ? String(attrs[nameKey]) : (g.layer?.title ?? '')
      this.emit('hover', { title, x: ev.x, y: ev.y })
    })
  }

  /* ── Boundaries & global area filter ── */

  private async loadBoundaries(): Promise<void> {
    const out: BoundaryOption[] = []
    await Promise.all(
      BOUNDARY_SETS.map(async (b) => {
        const layer = this.entries.find((e) => e.title === b.layerTitle)?.layer
        if (!layer) return
        try {
          const res = await layer.queryFeatures({
            where: '1=1',
            outFields: [b.nameField, ...(b.displayField ? [b.displayField] : [])],
            returnGeometry: false,
            orderByFields: [b.nameField],
          } as any)
          for (const f of res.features) {
            const name = String(f.attributes[b.nameField] ?? '').trim()
            if (!name) continue
            const display = b.displayField ? String(f.attributes[b.displayField] ?? name) : name
            out.push({ group: b.group, name, display })
          }
        } catch {
          /* boundary layer unavailable; the group is simply absent */
        }
      }),
    )
    // de-dup, keep registry group order then alphabetical
    const groupOrder = [...new Set(BOUNDARY_SETS.map((b) => b.group))]
    const seen = new Set<string>()
    this.boundaries = out
      .filter((o) => (seen.has(o.group + o.name) ? false : (seen.add(o.group + o.name), true)))
      .sort(
        (a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) || a.name.localeCompare(b.name),
      )
    this.emit('boundaries', [...this.boundaries])
  }

  private async boundaryGeometry(group: string, name: string): Promise<Geometry | null> {
    const key = `${group}|${name}`
    const cached = this.boundaryGeomCache.get(key)
    if (cached) return cached
    const sets = BOUNDARY_SETS.filter((b) => b.group === group)
    for (const b of sets) {
      const layer = this.entries.find((e) => e.title === b.layerTitle)?.layer
      if (!layer) continue
      try {
        const res = await layer.queryFeatures({
          where: `${b.nameField} = '${name.replace(/'/g, "''")}'`,
          returnGeometry: true,
          outFields: [b.nameField],
          outSpatialReference: this.view?.spatialReference,
        } as any)
        const geom = res.features[0]?.geometry
        if (geom) {
          this.boundaryGeomCache.set(key, geom)
          return geom
        }
      } catch {
        /* try the next layer in the group */
      }
    }
    return null
  }

  /** Set the global area filter from picked boundaries and/or a custom shape. */
  async applyAreaFilter(
    picks: { group: string; name: string }[],
    customGeometry: Geometry | null,
  ): Promise<void> {
    const geoms: Geometry[] = []
    for (const p of picks) {
      const g = await this.boundaryGeometry(p.group, p.name)
      if (g) geoms.push(g)
    }
    if (customGeometry) geoms.push(customGeometry)
    const union =
      geoms.length === 0 ? null : geoms.length === 1 ? geoms[0] : (geometryEngine.union(geoms as any) as Geometry)
    this.areaGeometry = union
    await this.applyFilters()
    this.emit('areaGeometry', union)
    if (union && this.view) this.view.goTo(union as any).catch(() => undefined)
    if (!union && this.view)
      this.view.goTo({ center: DEFAULT_VIEW.center, zoom: DEFAULT_VIEW.zoom }).catch(() => undefined)
  }

  private async applyFilters(): Promise<void> {
    const view = this.view
    if (!view) return
    const filter = this.areaGeometry
      ? new FeatureFilter({ geometry: this.areaGeometry, spatialRelationship: 'intersects' })
      : null
    const apply = async (layer: FeatureLayer) => {
      try {
        const lv = await view.whenLayerView(layer)
        ;(lv as any).filter = filter
      } catch {
        /* layer view not created yet — filter applies when it is */
      }
    }
    // Only layers the map actually holds: whenLayerView never resolves for a
    // parked layer, and setLayerVisible/setSymbology re-assert the filter on
    // whichever layer is unparked next.
    for (const e of this.entries)
      if (!REFERENCE_LAYER_TITLES.test(e.title))
        for (const layer of this.layersOf(e)) if (!this.parkedLayers.has(String(layer.id))) void apply(layer)
  }

  /** Re-assert the global area filter on one layer (a newly visible child). */
  private async applyAreaFilterTo(e: CatalogEntry, layer: FeatureLayer): Promise<void> {
    const view = this.view
    if (!view || REFERENCE_LAYER_TITLES.test(e.title)) return
    const filter = this.areaGeometry
      ? new FeatureFilter({ geometry: this.areaGeometry, spatialRelationship: 'intersects' })
      : null
    try {
      const lv = await view.whenLayerView(layer)
      ;(lv as any).filter = filter
    } catch {
      /* layer view not created yet — filter applies when it is */
    }
  }

  /* ── Custom area sketch / upload ── */

  drawCustomArea(): Promise<Geometry | null> {
    return this.sketchGeometry('polygon')
  }

  private sketchGeometry(tool: 'polygon' | 'polyline' | 'point'): Promise<Geometry | null> {
    const sk = this.sketch
    if (!sk) return Promise.resolve(null)
    this.sketchLayer.removeAll()
    this.emit('sketchActive', true)
    return new Promise((resolve) => {
      const handle = sk.on('create', (ev) => {
        if (ev.state === 'complete') {
          handle.remove()
          this.emit('sketchActive', false)
          resolve(ev.graphic?.geometry ?? null)
        } else if (ev.state === 'cancel') {
          handle.remove()
          this.emit('sketchActive', false)
          resolve(null)
        }
      })
      sk.create(tool)
    })
  }

  cancelSketch(): void {
    this.sketch?.cancel()
  }

  clearSketch(): void {
    this.sketchLayer.removeAll()
  }

  /** Parse an uploaded GeoJSON file into a single (multi)polygon geometry. */
  geoJsonToGeometry(text: string): Geometry | null {
    try {
      const gj = JSON.parse(text)
      const polys: Polygon[] = []
      const addGeom = (geom: any) => {
        if (!geom) return
        if (geom.type === 'Polygon') polys.push(new Polygon({ rings: geom.coordinates, spatialReference: { wkid: 4326 } }))
        if (geom.type === 'MultiPolygon')
          for (const rings of geom.coordinates)
            polys.push(new Polygon({ rings, spatialReference: { wkid: 4326 } }))
      }
      if (gj.type === 'FeatureCollection') for (const f of gj.features ?? []) addGeom(f.geometry)
      else if (gj.type === 'Feature') addGeom(gj.geometry)
      else addGeom(gj)
      if (!polys.length) return null
      const merged = polys.length === 1 ? polys[0] : (geometryEngine.union(polys as any) as Polygon)
      return (webMercatorUtils.geographicToWebMercator(merged) as Geometry) ?? merged
    } catch {
      return null
    }
  }

  /* ── Basemap gallery ── */

  /** Basemap switcher, 1.0 parity. The gallery itself is built on first
   *  expand: instantiating it eagerly would make every item resolve its
   *  basemap's spatial reference and thumbnail, loading a dozen basemaps'
   *  layers at startup for a panel most sessions never open. */
  private makeBasemapExpand(view: MapView): Expand {
    const expand = new Expand({
      view,
      expandIcon: 'basemap',
      expandTooltip: 'Basemap',
      collapseTooltip: 'Close basemap gallery',
      mode: 'floating',
      // Collapse when the user goes back to the map, matching Search's behavior.
      autoCollapse: true,
    })
    reactiveUtils.when(
      () => expand.expanded,
      () => {
        expand.content = new BasemapGallery({ view, source: this.basemapSource(view), headingLevel: 2 })
      },
      { once: true },
    )
    return expand
  }

  /** The gallery list: well-known basemaps the SDK resolves locally, so the
   *  list costs no portal query and doesn't drift with the org's gallery.
   *
   *  The web map's own basemap takes the place of its well-known twin rather
   *  than sitting alongside it. The gallery matches the active basemap by
   *  layer URL, and the authored copy's vector-tile styles are served from
   *  cdn.arcgis.com where `fromId`'s come from www.arcgis.com — so a plain
   *  list opens with nothing selected. Substituting the object, rather than
   *  reassigning the view's basemap, keeps the map drawing exactly what the
   *  web map authored. */
  private basemapSource(view: MapView): Basemap[] {
    const list = BASEMAP_IDS.map((id) => Basemap.fromId(id)).filter((b): b is Basemap => !!b)
    const current = view.map?.basemap
    if (!current) return list
    const twin = list.findIndex((b) => b.id === WEB_MAP_BASEMAP_ID)
    if (twin < 0) return [current, ...list]
    // The authored basemap carries no thumbnail of its own; borrow the twin's.
    current.thumbnailUrl ??= list[twin].thumbnailUrl
    list[twin] = current
    return list
  }

  /* ── Legend (reflects what's on screen) ── */

  attachLegend(target: HTMLElement | null): void {
    if (!target) return
    // The mount can arrive before the web map has loaded; doInit picks this up.
    if (!this.view) {
      this.pendingLegendTarget = target
      return
    }
    if (!this.legendEl) {
      this.legendEl = document.createElement('div')
      this.legend = new Legend({ view: this.view, container: this.legendEl })
    }
    if (this.legendEl.parentNode !== target) target.appendChild(this.legendEl)
  }

  /** Frame a geometry at segment scale (1:24,000), so a short segment does
   *  not zoom absurdly far in. */
  zoomTo(geometry: Geometry | null, fit = false): void {
    if (geometry && this.view)
      this.view.goTo((fit ? { target: geometry } : { target: geometry, scale: 24000 }) as any).catch(() => undefined)
  }

  /** The global area filter's geometry (union of picked boundaries), or null region-wide. */
  get area(): Geometry | null {
    return this.areaGeometry
  }

  /** PNG data URI of the current map, for the report and the Help dialog's
   *  image export. Null if the view cannot produce one. */
  async takeScreenshot(): Promise<string | null> {
    if (!this.view) return null
    try {
      const shot = await this.view.takeScreenshot({ format: 'png' })
      return shot.dataUrl
    } catch {
      return null
    }
  }
}

/** Anything that owns an ordered layer collection: the web map, or a group. */
type MapLayer = { id: string | number; layers?: unknown }
interface LayerContainer {
  layers: { toArray(): MapLayer[]; remove(l: MapLayer): unknown; add(l: MapLayer, i?: number): unknown }
}

function toArray(col: LayerContainer['layers'] | undefined): MapLayer[] {
  return typeof col?.toArray === 'function' ? col.toArray() : []
}

/** A group layer's feature-layer children, in authored order. */
function childLayers(g: GroupLayer): FeatureLayer[] {
  const raw = (g as any).layers
  const arr: any[] = typeof raw?.toArray === 'function' ? raw.toArray() : Array.isArray(raw) ? raw : []
  return arr.filter((c) => c?.type === 'feature') as FeatureLayer[]
}

/** The single field a renderer symbolizes, whichever convention it arrived in
 *  (`field` for class breaks and SDK unique-value, `field1` from web map JSON). */
function rendererField(r: unknown): string | null {
  const any = r as { field?: unknown; field1?: unknown } | null | undefined
  if (typeof any?.field === 'string' && any.field) return any.field
  if (typeof any?.field1 === 'string' && any.field1) return any.field1
  return null
}

/** "12 fields" — the catalog row's metadata line. Empty until the layer's
 *  own metadata has loaded, so the row never claims "0 fields". */
function metaFields(fl: FeatureLayer): string {
  if (!fl.loaded) return ''
  const n = (fl.fields ?? []).filter(
    (f: Field) =>
      !SKIP_FIELDS.test(f.name) && ['double', 'integer', 'single', 'small-integer', 'string'].includes(f.type),
  ).length
  return `${n} ${n === 1 ? 'field' : 'fields'}`
}

function errMsg(err: unknown, fallback: string): string {
  return (err instanceof Error && err.message) || fallback
}

/** Singleton — one view for the whole app (per handoff). */
export const controller = new MapController()