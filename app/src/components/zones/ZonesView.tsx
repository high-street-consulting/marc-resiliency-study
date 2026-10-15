import { useEffect, useRef, useState } from 'react'
import type Geometry from '@arcgis/core/geometry/Geometry'
import { Icon } from '../icons'
import { controller } from '../../map/controller'
import type { CatalogEntry, SelectedFeature } from '../../map/controller'
import { SCENARIO_STORY as S, THRESHOLDS_FT, ZONE_FIELDS } from '../../config/registry'
import { mi, n0, readStory, readZonesCsvRows, scenarioLayers } from '../../lib/zones'
import type { Story } from '../../lib/zones'
import { downloadCsv, openReport, slug } from '../../lib/exporters'
import { DetailSidebar } from '../explore/DetailSidebar'
import { MapLegend } from '../MapLegend'

export function ZonesView(props: {
  vp: 'desktop' | 'tablet' | 'phone'
  tablePanel: React.ReactNode
  drawerOpen: boolean
  onDrawerOpen: (v: boolean) => void
  layers: CatalogEntry[]
  areaLabel: string
  mapError: string
  selected: SelectedFeature | null
  onClearSelected: () => void
  onOpenTable: (layerId?: string | null) => void
}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const legendRef = useRef<HTMLDivElement>(null)
  const narrow = props.vp !== 'desktop'
  const [legendOpen, setLegendOpen] = useState(props.vp === 'desktop')
  const [area, setArea] = useState<Geometry | null>(controller.area)
  const [threshold, setThreshold] = useState<number | null>(controller.threshold)
  const [story, setStory] = useState<Story | null>(null)
  const [failed, setFailed] = useState(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    controller.attach(mountRef.current)
    controller.attachLegend(legendRef.current)
  })
  useEffect(() => controller.on('areaGeometry', setArea), [])
  useEffect(() => controller.on('threshold', setThreshold), [])

  const rows = props.layers.filter((l) => l.section === S.section)
  const zonesRow = rows.find((l) => S.zones.title.test(l.title))
  const scenario = zonesRow?.symbologies.find((s) => s.id === zonesRow.activeSymbology)?.label ?? null
  const { zones, closed } = scenarioLayers(props.layers, scenario)

  useEffect(() => {
    setStory(null)
    setFailed(false)
    if (!zones && !closed) return
    let live = true
    readStory(zones, closed, area, threshold)
      .then((s) => live && setStory(s))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [zones, closed, area, threshold])

  const pickScenario = (label: string) => {
    for (const r of rows) {
      const opt = r.symbologies.find((s) => s.label === label)
      if (opt) controller.setSymbology(r.id, opt.id)
    }
  }

  const exportCsv = () => {
    if (!zones || !scenario) return
    setExporting(true)
    readZonesCsvRows(zones, area, threshold)
      .then((data) =>
        downloadCsv(data, ZONE_FIELDS, `marc-stranded-zones-${slug(scenario)}-${threshold ?? 'all'}ft-${new Date().toISOString().slice(0, 10)}.csv`),
      )
      .catch(() => setFailed(true))
      .finally(() => setExporting(false))
  }
  const exportReport = () => {
    if (!story || !scenario) return
    const aliases = Object.fromEntries((zones?.fields ?? []).map((f) => [f.name, f.alias || f.name]))
    void controller.takeScreenshot().then((shot) =>
      openReport({ scenario, thresholdFt: threshold, areaLabel: props.areaLabel, story, aliases, mapDataUrl: shot }),
    )
  }

  const selectedEntry = props.selected ? controller.entryForLayerId(String(props.selected.layer.id)) : undefined
  const st = story
  const small: React.CSSProperties = { font: '400 10.5px/1.4 var(--sc-font)', color: 'var(--sc-gray-dark)' }
  const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, font: '600 11px/1.3 var(--sc-font)', color: 'var(--sc-text)' }

  const panel = (
    <aside
      aria-label="Stranded zones results"
      style={{
        width: narrow ? '100%' : 360,
        flex: narrow ? 1 : 'none',
        minHeight: 0,
        background: '#fff',
        borderRight: '1px solid var(--sc-gray-light)',
        overflow: 'auto',
        padding: '14px 16px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div>
        <div className="sc-overline" style={{ color: 'var(--sc-blue-deep)', marginBottom: 3 }}>Stranded zones</div>
        <h2 style={{ margin: 0, font: '600 15px/1.25 var(--sc-font)', color: 'var(--sc-text)' }}>{scenario ?? 'No scenario published'}</h2>
      </div>
      {zonesRow && zonesRow.symbologies.length > 0 && (
        <label style={label}>
          Scenario
          <select className="sc-select" value={scenario ?? ''} onChange={(ev) => pickScenario(ev.target.value)}>
            {zonesRow.symbologies.map((s) => (
              <option key={s.id} value={s.label}>{s.label}</option>
            ))}
          </select>
        </label>
      )}
      <label style={label}>
        Closure depth
        <select className="sc-select" value={threshold ?? ''} onChange={(ev) => controller.setThreshold(Number(ev.target.value))}>
          {THRESHOLDS_FT.map((t) => (
            <option key={t} value={t}>{`${t} ft`}</option>
          ))}
        </select>
        <span style={{ ...small, fontWeight: 400 }}>Edges deeper than this are closed. Zones, detours and the numbers below follow.</span>
      </label>
      <div style={small}>
        <b style={{ color: 'var(--sc-text)' }}>{props.areaLabel}</b>. Change the area in the bar above.
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="sc-btn" onClick={exportCsv} disabled={!zones || exporting}>
          <Icon name="file-csv" style={{ color: '#555' }} />
          Export CSV
        </button>
        <button className="sc-btn sc-btn--solid" onClick={exportReport} disabled={!st}>
          <Icon name="file-report" />
          Export report
        </button>
      </div>
      {failed && <div className="sc-error">The scenario layers could not be read.</div>}
      {!st && !failed && (zones || closed) && <div style={{ ...small, fontSize: 11.5 }}>Reading the scenario…</div>}
      {st && (
        <>
          <Big value={n0(st.closed.n)} label="road segments close" note={`${n0(st.closed.noDetour)} of them lose every alternative route. Where a detour exists it averages ${mi(st.closed.avg)} mi, the longest ${mi(st.closed.max)} mi.`} />
          <Big value={n0(st.stranded.n)} label={st.stranded.n === 1 ? 'zone is cut off' : 'zones are cut off'} note={`No way in or out: about ${n0(st.stranded.population)} residents, ${n0(st.stranded.jobs)} jobs, ${n0(st.stranded.facilities)} critical facilities and ${n0(st.stranded.miles)} road miles.`} />
          <Big value={n0(st.single.n)} label={st.single.n === 1 ? 'zone keeps one way out' : 'zones keep one way out'} note={`Still reachable, but by a single surviving road; about ${n0(st.single.population)} residents.`} />
          {st.top.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="sc-overline" style={{ marginBottom: 4 }}>Largest cut-off zones by population</div>
              {st.top.map((z) => (
                <button
                  key={`${z.type}-${z.id}`}
                  className="sc-need-row"
                  aria-label={`Select and zoom to zone ${z.id}, ${n0(z.population)} residents`}
                  onClick={() => {
                    if (zones) controller.selectFeature(zones, z.graphic)
                    controller.zoomTo(z.geometry, true)
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ font: '400 11.5px/1.25 var(--sc-font)', color: 'var(--sc-text)' }}>
                      Zone {z.id} · {z.type === 'stranded' ? 'stranded' : 'one way out'}
                    </span>
                    <span style={{ font: '400 10px/1.2 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>
                      {n0(z.jobs)} jobs · {mi(z.miles)} mi{z.facilities ? ` · ${n0(z.facilities)} facilities` : ''}
                    </span>
                  </span>
                  <span style={{ font: '600 13px/1 var(--sc-font)', color: 'var(--sc-navy)' }}>{n0(z.population)}</span>
                </button>
              ))}
            </div>
          )}
          <div style={{ ...small, fontSize: 10 }}>
            Population and jobs are 2020 tract totals allocated to road miles; treat them as order of magnitude. Bridges are assumed to stay open.
          </div>
        </>
      )}
    </aside>
  )

  const detail = props.selected && (
    <DetailSidebar
      selected={props.selected}
      activeAttrField={selectedEntry?.filterField ?? undefined}
      onClose={props.onClearSelected}
      onOpenTable={() => props.onOpenTable(selectedEntry?.id ?? null)}
    />
  )

  return (
    <>
      {!narrow && panel}
      <main style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <div ref={mountRef} style={{ position: 'absolute', inset: 0, background: '#eceae5' }} />
          {!!props.mapError && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--sc-ground)' }}>
              <div className="sc-error" style={{ maxWidth: 420, border: '1px solid var(--sc-gray-light)', background: '#fff' }}>
                <b style={{ fontSize: 13.5 }}>The map could not load</b>
                <span style={{ fontSize: 12 }}>{props.mapError}</span>
              </div>
            </div>
          )}
          <MapLegend
            legendRef={legendRef}
            open={legendOpen}
            onToggle={() => setLegendOpen((v) => !v)}
            onOpenTable={() => props.onOpenTable(zonesRow?.id ?? null)}
          />
          {narrow && props.drawerOpen && (
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
                onClick={() => props.onDrawerOpen(false)}
              >
                Close
              </button>
              {panel}
            </div>
          )}
        </div>
        {props.tablePanel}
      </main>
      {detail &&
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
            {detail}
          </div>
        ) : (
          detail
        ))}
    </>
  )
}

function Big({ value, label, note }: { value: string; label: string; note: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ font: '600 24px/1 var(--sc-font)', color: 'var(--sc-navy)' }}>{value}</span>
        <span style={{ font: '400 12px/1.2 var(--sc-font)', color: 'var(--sc-text)' }}>{label}</span>
      </div>
      <div style={{ font: '400 10.5px/1.4 var(--sc-font)', color: 'var(--sc-text-mid)' }}>{note}</div>
    </div>
  )
}
