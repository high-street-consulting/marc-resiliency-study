/**
 * App — the single owner of application state, and the only place the map
 * controller and the React tree meet.
 *
 * ## Shape of the thing
 *
 * There is no store and no context. Every piece of shared state is a `useState`
 * here, passed down as props; child components are presentational and talk to
 * the map only through the `controller` singleton — see `src/map/controller.ts`.
 *
 * ## Where state lives
 *
 * - **Catalog and map** — `layers`, `boundaries`, `selected`, `mapError` are
 *   pushed up from the controller through `controller.on(...)` events, not read
 *   synchronously. The controller is the source of truth for anything the SDK
 *   can change behind our back (layer visibility especially).
 * - **Area filter** — `areas` + `customArea` ride in the
 *   URL. `applyAreas` is the only writer.
 *
 * ## Conventions worth keeping
 *
 * - The URL is written debounced from state (never read back mid-session), and
 *   `initial` is applied exactly once — see `initialApplied`.
 * - Anything the SDK owns is re-read from the SDK rather than assumed.
 */

import marcLogoWhite from './assets/marc-logo-white.svg'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type Geometry from '@arcgis/core/geometry/Geometry'

import { controller } from './map/controller'
import type { BoundaryOption, CatalogEntry, SelectedFeature } from './map/controller'
import { decodeState, encodeState } from './lib/urlState'
import { useViewport } from './lib/viewport'

import { Header } from './components/Header'
import { AreaBar } from './components/AreaBar'
import { ExploreView } from './components/explore/ExploreView'
import { HelpDialog } from './components/HelpDialog'
import { TablePanel } from './components/TablePanel'
import { ATTRIBUTION, REFERENCE_LAYER_TITLES } from './config/registry'

export interface AreaPick {
  group: string
  name: string
}

export default function App() {
  const initial = useMemo(() => decodeState(location.search), [])
  const vp = useViewport()

  const [areas, setAreas] = useState<AreaPick[]>(initial.areas ?? [])
  const [customArea, setCustomArea] = useState<{ geometry: Geometry; label: string } | null>(null)
  const [boundaries, setBoundaries] = useState<BoundaryOption[]>([])
  const [layers, setLayers] = useState<CatalogEntry[]>([])
  const [layersError, setLayersError] = useState('')
  const [mapError, setMapError] = useState('')
  const [loadingLayers, setLoadingLayers] = useState(true)
  const [selected, setSelected] = useState<SelectedFeature | null>(null)
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [tableOpen, setTableOpen] = useState(false)
  const [tableLayerId, setTableLayerId] = useState<string | null>(null)
  const [shareCopied, setShareCopied] = useState(false)
  const [sketchActive, setSketchActive] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const initialApplied = useRef(false)

  /* ── Controller wiring ── */
  useEffect(() => {
    const offs = [
      controller.on('layers', (ls) => {
        setLayers(ls)
        setLoadingLayers(false)
      }),
      controller.on('layersError', (e) => {
        setLayersError(e)
        setLoadingLayers(false)
      }),
      controller.on('mapError', setMapError),
      controller.on('selected', setSelected),
      controller.on('boundaries', setBoundaries),
      controller.on('sketchActive', setSketchActive),
    ]
    void controller.init()
    return () => offs.forEach((off) => off())
  }, [])

  // Apply URL-restored symbology and layer visibility once the catalog arrives.
  useEffect(() => {
    if (initialApplied.current || !layers.length) return
    initialApplied.current = true
    // Symbology first: picking a child inside a still-hidden group settles the
    // exclusive selection before the group is switched on. Unrecognised ids are
    // ignored, so an old-format link degrades to the web map's own defaults
    // rather than throwing or blanking the map.
    if (initial.attrs) {
      for (const [id, optionId] of Object.entries(initial.attrs)) {
        const e = controller.entryForLayerId(id) ?? controller.entryForLayerId(optionId)
        if (e) controller.setSymbology(e.id, optionId)
      }
    }
    if (initial.visible?.length) {
      // A link may name a child layer; resolve every id to its catalog row.
      const wanted = new Set<string>()
      for (const id of initial.visible) {
        const e = controller.entryForLayerId(id)
        if (e) wanted.add(e.id)
      }
      // If nothing resolves the link predates this map — keep the web map's
      // own visibility instead of turning everything off.
      if (wanted.size) for (const e of layers) controller.setLayerVisible(e.id, wanted.has(e.id))
    }
    // Visibility is now whatever the SDK settled on, not what we asked for.
    const live = controller.entries
    const firstOn = live.find((l) => l.on && !REFERENCE_LAYER_TITLES.test(l.title)) ?? live.find((l) => l.on)
    setActiveLayerId(firstOn?.id ?? live[0]?.id ?? null)
    if (initial.areas?.length) void controller.applyAreaFilter(initial.areas, null)
  }, [layers, initial])

  /* ── Global area filter ── */
  const applyAreas = useCallback(
    (next: AreaPick[], custom: { geometry: Geometry; label: string } | null) => {
      setAreas(next)
      setCustomArea(custom)
      void controller.applyAreaFilter(next, custom?.geometry ?? null)
    },
    [],
  )

  /* ── Shareable URL (FR-6) ── */
  useEffect(() => {
    const t = setTimeout(() => {
      const url =
        location.pathname +
        encodeState({
          areas,
          visible: layers.filter((l) => l.on).map((l) => l.id),
          // Symbology rides in the URL as the visible child layer's id, and
          // only when it is not the group's authored default.
          attrs: Object.fromEntries(
            layers
              .filter((l) => l.activeSymbology && l.defaultSymbology && l.defaultSymbology !== l.activeSymbology)
              .map((l) => [l.id, l.activeSymbology as string]),
          ),
        })
      history.replaceState(null, '', url || location.pathname)
    }, 300)
    return () => clearTimeout(t)
  }, [areas, layers])

  const share = useCallback(() => {
    navigator.clipboard
      ?.writeText(location.href)
      .then(() => {
        setShareCopied(true)
        setTimeout(() => setShareCopied(false), 2000)
      })
      .catch(() => undefined)
  }, [])

  const openTable = useCallback(
    (layerId?: string | null) => {
      setTableLayerId((cur) => layerId ?? cur ?? activeLayerId)
      setTableOpen(true)
    },
    [activeLayerId],
  )

  const tablePanel = (
    <TablePanel
      open={tableOpen}
      onClose={() => setTableOpen(false)}
      layers={layers}
      layerId={tableLayerId}
      onLayerId={setTableLayerId}
    />
  )

  return (
    <div
      style={{
        height: '100vh',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: '#fff',
      }}
    >
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <Header onShare={share} shareCopied={shareCopied} onHelp={() => setHelpOpen(true)} vp={vp} />
      <AreaBar
        boundaries={boundaries}
        areas={areas}
        customArea={customArea}
        sketchActive={sketchActive}
        onChange={applyAreas}
        vp={vp}
        leading={
          vp !== 'desktop' ? (
            <button
              className="sc-btn"
              style={{ flex: 'none', padding: '0 10px' }}
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen((v) => !v)}
            >
              Layers
            </button>
          ) : null
        }
      />
      <div id="main" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <ExploreView
          vp={vp}
          tablePanel={tablePanel}
          drawerOpen={drawerOpen}
          onDrawerOpen={setDrawerOpen}
          layers={layers}
          loadingLayers={loadingLayers}
          layersError={layersError}
          mapError={mapError}
          activeLayerId={activeLayerId}
          selected={selected}
          onActiveLayer={setActiveLayerId}
          onSymbology={(entryId, optionId) => {
            setActiveLayerId(entryId)
            controller.setSymbology(entryId, optionId)
          }}
          onToggleLayer={(id, on) => {
            controller.setLayerVisible(id, on)
            if (on) setActiveLayerId(id)
          }}
          onClearSelected={() => setSelected(null)}
          onOpenTable={openTable}
        />
      </div>
      <div className="marc-bands" aria-hidden />
      <footer
        style={{
          height: 30,
          flex: 'none',
          background: '#000',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 16px',
        }}
      >
        <img src={marcLogoWhite} alt="Mid-America Regional Council" style={{ height: 16, width: 'auto' }} />
        <div style={{ font: '400 10px/1.3 var(--sc-font)', color: 'rgba(255,255,255,.65)' }}>{ATTRIBUTION}</div>
      </footer>

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  )
}