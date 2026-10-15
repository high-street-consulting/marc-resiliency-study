/**
 * Explore tab layout — the catalog aside, the shared map, and the conditional
 * feature-detail rail.
 *
 * Owns no data. Its two jobs beyond layout are to mount the shared MapView and
 * the legend into this tab's DOM (`controller.attach` / `attachLegend`, in an
 * effect with no dependency array so a re-render after a tab switch re-parents
 * them), and to subscribe to hover for the map tooltip.
 *
 * On tablet/phone the catalog becomes a drawer, controlled by App so the header
 * button and this view agree.
 */

import { useEffect, useRef, useState } from 'react'
import { controller } from '../../map/controller'
import type { CatalogEntry, SelectedFeature } from '../../map/controller'
import { Catalog } from './Catalog'
import { DetailSidebar } from './DetailSidebar'
import { MapLegend } from '../MapLegend'

export function ExploreView(props: {
  vp: 'desktop' | 'tablet' | 'phone'
  tablePanel: React.ReactNode
  drawerOpen: boolean
  onDrawerOpen: (v: boolean) => void
  layers: CatalogEntry[]
  areaLabel: string
  loadingLayers: boolean
  layersError: string
  mapError: string
  activeLayerId: string | null
  selected: SelectedFeature | null
  onActiveLayer: (id: string) => void
  onSymbology: (entryId: string, optionId: string) => void
  onToggleLayer: (id: string, on: boolean) => void
  onClearSelected: () => void
  onOpenTable: (layerId?: string | null) => void
  onOpenZones?: () => void
}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const legendRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ title: string; x: number; y: number } | null>(null)
  const narrow = props.vp !== 'desktop'
  const drawerOpen = props.drawerOpen
  const setDrawerOpen = props.onDrawerOpen
  const [legendOpen, setLegendOpen] = useState(props.vp === 'desktop')

  useEffect(() => {
    controller.attach(mountRef.current)
    controller.attachLegend(legendRef.current)
  })
  useEffect(() => controller.on('hover', setHover), [])

  // The field the SELECTED feature's layer is symbolized by, read live off its
  // renderer, so the detail pane's headline matches what the map is drawing.
  // The clicked layer may be a group child, so resolve it to its catalog row.
  const selectedEntry = props.selected ? controller.entryForLayerId(String(props.selected.layer.id)) : undefined
  const selectedAttrField = selectedEntry?.filterField ?? undefined

  const catalog = (
      <Catalog
        layers={props.layers}
        loading={props.loadingLayers}
        error={props.layersError}
        onSymbology={props.onSymbology}
        onToggleLayer={props.onToggleLayer}
        onOpenTable={props.onOpenTable}
      />
  )

  return (
    <>
      {!narrow && catalog}
      <main style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <div ref={mountRef} style={{ position: 'absolute', inset: 0, background: '#eceae5' }} />
          {!!props.mapError && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--sc-ground)',
              }}
            >
              <div
                className="sc-error"
                style={{ maxWidth: 420, border: '1px solid var(--sc-gray-light)', background: '#fff' }}
              >
                <b style={{ fontSize: 13.5 }}>The map could not load</b>
                <span style={{ fontSize: 12 }}>{props.mapError}</span>
              </div>
            </div>
          )}
          <MapLegend
            legendRef={legendRef}
            open={legendOpen}
            onToggle={() => setLegendOpen((v) => !v)}
            onOpenTable={() => props.onOpenTable(props.activeLayerId)}
          />
          {narrow && (
            <>
              {drawerOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    bottom: 0,
                    zIndex: 30,
                    width: 'min(340px, 92vw)',
                    boxShadow: 'var(--sc-shadow-modal)',
                    display: 'flex',
                    flexDirection: 'column',
                    background: '#fff',
                  }}
                >
                  <button
                    className="sc-btn sc-btn--small"
                    style={{ position: 'absolute', top: 10, right: 10, zIndex: 31 }}
                    onClick={() => setDrawerOpen(false)}
                  >
                    Close
                  </button>
                  {catalog}
                </div>
              )}
            </>
          )}
          {/* Hover tooltip — names a segment before the user commits to a click */}
          {hover && hover.title && (
            <div
              aria-hidden
              style={{
                position: 'absolute',
                left: hover.x + 12,
                top: hover.y + 12,
                pointerEvents: 'none',
                background: 'var(--sc-navy)',
                color: '#fff',
                font: '400 11px/1.2 var(--sc-font)',
                padding: '4px 8px',
                borderRadius: 2,
                maxWidth: 260,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {hover.title}
            </div>
          )}
        </div>
        {props.tablePanel}
      </main>
      {props.selected &&
        (narrow ? (
          <div
            style={{
              position: 'fixed',
              top: 98,
              right: 0,
              bottom: 30,
              zIndex: 28,
              width: 'min(360px, 100vw)',
              boxShadow: 'var(--sc-shadow-modal)',
              display: 'flex',
            }}
          >
            <DetailSidebar
              selected={props.selected}
              activeAttrField={selectedAttrField}
              onClose={props.onClearSelected}
              onOpenTable={() => props.onOpenTable(selectedEntry?.id ?? null)}
              onOpenZones={props.onOpenZones}
            />
          </div>
        ) : (
          <DetailSidebar
            selected={props.selected}
            activeAttrField={selectedAttrField}
            onClose={props.onClearSelected}
            onOpenTable={() => props.onOpenTable(selectedEntry?.id ?? null)}
            onOpenZones={props.onOpenZones}
          />
        ))}
    </>
  )
}
