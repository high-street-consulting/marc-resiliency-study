import { useEffect, useMemo, useRef, useState } from 'react'
import type Field from '@arcgis/core/layers/support/Field'
import { Icon } from '../icons'
import { controller } from '../../map/controller'
import type { CatalogEntry } from '../../map/controller'
import { MAX_ATTRIBUTE_RADIOS, PCT_LIKE } from '../../config/registry'
import { numericStats, useStatsVersion } from '../../lib/stats'
import { fmtStat } from '../../lib/format'

interface FilterVal {
  code?: string
  lo?: number
  hi?: number
  text?: string
}

/** Layer catalog — 340px aside. Accordion sections, search, per-layer
 *  symbolize-by radios and a type-matched filter bound to the symbolized
 *  attribute (FR-1, FR-2).
 *
 *  The symbolize-by choices are the child layers of the web map's exclusive
 *  group layer for that row — the labels are their titles, authored in the
 *  Map Viewer. A layer with no group has no symbolize-by control at all. */
export function Catalog({
  layers,
  loading,
  error,
  onSymbology,
  onToggleLayer,
  onOpenTable,
}: {
  layers: CatalogEntry[]
  loading: boolean
  error: string
  onSymbology: (entryId: string, optionId: string) => void
  onToggleLayer: (id: string, on: boolean) => void
  onOpenTable: (layerId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [openSections, setOpenSections] = useState<Record<string, boolean> | null>(null)
  const [filters, setFilters] = useState<Record<string, FilterVal>>({})
  const [singleLayer, setSingleLayer] = useState(false)
  const lastOnRef = useRef<string | null>(null)
  useStatsVersion() // re-render when a pending stats query resolves

  const q = query.trim().toLowerCase()
  const matches = useMemo(
    () =>
      layers.filter(
        (l) =>
          !q ||
          l.title.toLowerCase().includes(q) ||
          l.meta.toLowerCase().includes(q) ||
          l.symbologies.some((s) => s.label.toLowerCase().includes(q)),
      ),
    [layers, q],
  )

  // Section order comes from the web map, not from config: the controller emits
  // rows in the Map Viewer's own top-down order, so the order sections first
  // appear in that list is the order to render them in.
  const sectionOrder = useMemo(() => {
    const seen = new Set<string>()
    const order: string[] = []
    for (const l of layers) {
      if (!seen.has(l.section)) {
        seen.add(l.section)
        order.push(l.section)
      }
    }
    return order
  }, [layers])

  const derivedOpen = useMemo(() => {
    const d: Record<string, boolean> = {}
    for (const l of layers) if (l.on) d[l.section] = true
    return d
  }, [layers])
  const openMap = openSections ?? derivedOpen

  // What is actually drawing: a row that is on inside a collapsed section is
  // not, so the header counts what the map shows rather than what is ticked.
  const onCount = layers.filter((l) => l.on && openMap[l.section]).length

  // The catalog's open sections gate layer visibility on the map.
  useEffect(() => {
    controller.setOpenSections(Object.keys(openMap).filter((name) => openMap[name]))
  }, [openMap])

  /** All row toggles route through here so single-layer mode can enforce
   *  radio-style exclusivity via the same onToggleLayer path. A row is one
   *  catalog entry, so a symbology group counts as a single layer: turning
   *  another row on hides the whole group, never one of its children. */
  const toggleLayer = (id: string, on: boolean) => {
    if (on) {
      lastOnRef.current = id
      if (singleLayer) for (const l of layers) if (l.on && l.id !== id) onToggleLayer(l.id, false)
    }
    onToggleLayer(id, on)
  }

  const setSingleLayerMode = (on: boolean) => {
    setSingleLayer(on)
    if (!on) return // multi-layer mode: stop enforcing, leave visibility as-is
    const visible = layers.filter((l) => l.on)
    if (visible.length < 2) return
    const keep = visible.find((l) => l.id === lastOnRef.current)?.id ?? visible[0].id
    for (const l of visible) if (l.id !== keep) onToggleLayer(l.id, false)
  }

  const setFilter = (entry: CatalogEntry, field: Field, patch: FilterVal) => {
    const key = `${entry.id}|${field.name}`
    const fv = { ...filters[key], ...patch }
    const next = { ...filters, [key]: fv }
    setFilters(next)
    let where = ''
    if (fv.code !== undefined && fv.code !== '__all') {
      const f = (entry.layer.fields ?? []).find((x) => x.name === field.name)
      const isString = f?.type === 'string'
      where = `${field.name} = ${isString ? `'${fv.code.replace(/'/g, "''")}'` : fv.code}`
    } else if (fv.lo !== undefined || fv.hi !== undefined) {
      const parts: string[] = []
      if (fv.lo !== undefined) parts.push(`${field.name} >= ${fv.lo}`)
      if (fv.hi !== undefined) parts.push(`${field.name} <= ${fv.hi}`)
      where = parts.join(' AND ')
    } else if (fv.text) {
      where = `UPPER(${field.name}) LIKE UPPER('%${fv.text.replace(/'/g, "''")}%')`
    }
    controller.setDefinitionExpression(entry.id, where || null)
  }

  return (
    <aside
      aria-label="Data layers"
      style={{
        width: 340,
        flex: 'none',
        borderRight: '1px solid var(--sc-gray-light)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: '#fff',
      }}
    >
      <div
        style={{
          flex: 'none',
          padding: '12px 14px 11px',
          borderBottom: '1px solid var(--sc-card-border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, font: '600 15px/1.2 var(--sc-font)', color: 'var(--sc-text)' }}>Data layers</h2>
          <div style={{ font: '400 11.5px/1 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>
            {layers.length ? `${onCount} of ${layers.length} on` : ''}
          </div>
        </div>
        <div
          style={{
            height: 32,
            border: '1px solid var(--sc-input-border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 9px',
            borderRadius: 2,
          }}
        >
          <Icon name="search" style={{ color: 'var(--sc-gray-dark)' }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search layers, fields, and metadata"
            aria-label="Search layers, fields, and metadata"
            style={{
              flex: 1,
              minWidth: 0,
              border: 0,
              outline: 'none',
              font: '400 12.5px/1 var(--sc-font)',
              color: 'var(--sc-text)',
              background: 'transparent',
            }}
          />
          {query && (
            <button
              aria-label="Clear search"
              onClick={() => setQuery('')}
              style={{
                width: 18,
                height: 18,
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--sc-gray-dark)',
              }}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            className="sc-link-btn"
            onClick={() => {
              const d: Record<string, boolean> = {}
              for (const s of sectionOrder) d[s] = true
              setOpenSections(d)
            }}
          >
            Expand all
          </button>
          <button className="sc-link-btn" onClick={() => setOpenSections({})}>
            Collapse all
          </button>
          <label
            title="Turning a layer on hides every other layer in the catalog."
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              font: '400 11px/1 var(--sc-font)',
              color: 'var(--sc-gray-dark)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={singleLayer}
              onChange={(e) => setSingleLayerMode(e.target.checked)}
              style={{ margin: 0 }}
            />
            Show one layer at a time
          </label>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        {loading && (
          <div style={{ padding: 14, font: '400 12px/1.5 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>
            Loading layers from the MARC web map…
          </div>
        )}
        {!!error && (
          <div className="sc-error" style={{ margin: '12px 14px' }}>
            <b>The web map could not be read</b>
            <span>{error}</span>
          </div>
        )}
        {sectionOrder.map((name) => {
          const rows = matches.filter((l) => l.section === name)
          if (!rows.length) return null
          const secOn = rows.filter((r) => r.on).length
          const open = q ? true : !!openMap[name]
          return (
            <div key={name} style={{ borderBottom: '1px solid var(--sc-hairline)' }}>
              <button
                aria-expanded={open}
                onClick={() => setOpenSections({ ...openMap, [name]: !open })}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 14px 10px 9px',
                  width: '100%',
                  textAlign: 'left',
                  background: open ? '#fff' : '#f9f9f9',
                }}
              >
                <Icon
                  name="chevron-right"
                  style={{ color: '#555', transform: open ? 'rotate(90deg)' : 'none' }}
                />
                <span style={{ flex: 1, font: '600 13.5px/1.2 var(--sc-font)', color: 'var(--sc-text)' }}>{name}</span>
                <span
                  style={{
                    flex: 'none',
                    font: `${secOn ? 600 : 400} 10.5px/1 var(--sc-font)`,
                    color: secOn ? 'var(--sc-blue-deep)' : 'var(--sc-gray-dark)',
                  }}
                >
                  {rows.length}
                </span>
              </button>
              {open &&
                rows.map((l) => (
                  <LayerRow
                    key={l.id}
                    entry={l}
                    filters={filters}
                    onToggle={() => toggleLayer(l.id, !l.on)}
                    onSymbology={(optionId) => onSymbology(l.id, optionId)}
                    onFilter={setFilter}
                    onOpenTable={() => onOpenTable(l.id)}
                  />
                ))}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

function LayerRow({
  entry,
  filters,
  onToggle,
  onSymbology,
  onFilter,
  onOpenTable,
}: {
  entry: CatalogEntry
  filters: Record<string, FilterVal>
  onToggle: () => void
  onSymbology: (optionId: string) => void
  onFilter: (entry: CatalogEntry, field: Field, patch: FilterVal) => void
  onOpenTable: () => void
}) {
  const l = entry
  const [metaOpen, setMetaOpen] = useState(false)
  // One choice (or none) is not a choice: only a real exclusive group with
  // more than one child gets the symbolize-by control.
  const choices = l.symbologies.length > 1 ? l.symbologies : []
  const active = l.activeSymbology ?? choices[0]?.id
  return (
    <div
      style={{
        padding: '11px 14px 11px 26px',
        borderBottom: `1px solid ${l.on ? 'var(--sc-surface-blue-border)' : '#ececec'}`,
        background: l.on ? 'var(--sc-surface-blue)' : '#fff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          aria-pressed={l.on}
          aria-label={`${l.on ? 'Hide' : 'Show'} ${l.title}`}
          onClick={onToggle}
          style={{
            width: 24,
            height: 24,
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `1px solid ${l.on ? 'var(--sc-blue-deep)' : 'transparent'}`,
            background: l.on ? '#fff' : 'transparent',
            color: l.on ? 'var(--sc-blue-deep)' : 'var(--sc-gray-dark)',
            borderRadius: 2,
          }}
        >
          <Icon name={l.on ? 'view-visible' : 'view-hide'} size={16} />
        </button>
        <button
          onClick={onToggle}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            textAlign: 'left',
            background: 'transparent',
          }}
          tabIndex={-1}
          aria-hidden
        >
          <span style={{ font: `${l.on ? 600 : 400} 12.5px/1.3 var(--sc-font)`, color: 'var(--sc-text)' }}>
            {l.title}
          </span>
        </button>
        <button
          aria-label={`About ${l.title}`}
          aria-expanded={metaOpen}
          onClick={() => {
            // Field counts and the published description live on the service,
            // not in the web map, so ask for them the moment they are wanted.
            if (!l.ready) controller.loadEntryDetail(l.id)
            setMetaOpen((v) => !v)
          }}
          style={{ color: 'var(--sc-gray-dark)', display: 'flex', alignItems: 'center' }}
        >
          <Icon name="information" />
        </button>
      </div>
      {metaOpen && (
        <div style={{ margin: '8px 0 0 34px', font: '400 11px/1.5 var(--sc-font)', color: 'var(--sc-text-mid)' }}>
          <span style={{ color: 'var(--sc-gray-dark)' }}>{l.meta || 'Reading this layer…'} · </span>
          {l.ready
            ? l.layer.portalItem?.snippet || 'No description published for this layer.'
            : 'Description loading.'}{' '}
          {l.layer.portalItem?.id && (
            <a
              href={`https://www.arcgis.com/home/item.html?id=${l.layer.portalItem.id}`}
              target="_blank"
              rel="noreferrer"
            >
              Open metadata
            </a>
          )}{' '}
          · <button className="sc-link-btn" style={{ fontSize: 11 }} onClick={onOpenTable}>Attribute table</button>
        </div>
      )}
      {l.on && (
        <div style={{ paddingInlineStart: 34, display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 10 }}>
          {!!choices.length && (
            <>
              <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
                <legend
                  className="sc-overline"
                  style={{ padding: 0, color: '#555', fontSize: 10, marginBottom: 7 }}
                >
                  Symbolize by
                </legend>
                {choices.length <= MAX_ATTRIBUTE_RADIOS ? (
                  choices.map((s) => {
                    const sel = active === s.id
                    return (
                      <label key={s.id} className="sc-radio" style={{ alignItems: 'center' }}>
                        <input
                          type="radio"
                          name={`sym-${l.id}`}
                          checked={sel}
                          onChange={() => onSymbology(s.id)}
                        />
                        <span
                          style={{
                            font: `${sel ? 600 : 400} 12px/1.3 var(--sc-font)`,
                            color: 'var(--sc-text)',
                            minWidth: 0,
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {s.label}
                        </span>
                      </label>
                    )
                  })
                ) : (
                  <select
                    className="sc-select"
                    style={{ height: 28, fontSize: 11.5, width: '100%', minWidth: 0, maxWidth: '100%' }}
                    value={active}
                    aria-label={`Symbolize ${l.title} by`}
                    onChange={(e) => onSymbology(e.target.value)}
                  >
                    {choices.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                )}
              </fieldset>
              <div style={{ height: 1, background: 'var(--sc-surface-blue-border)', margin: '3px 0' }} />
            </>
          )}
          <FilterControl entry={l} filters={filters} onFilter={onFilter} />
        </div>
      )}
    </div>
  )
}

/** True when a stored filter value would actually narrow the layer. */
function isActive(fv: FilterVal | undefined): boolean {
  if (!fv) return false
  return (fv.code !== undefined && fv.code !== '__all') || fv.lo !== undefined || fv.hi !== undefined || !!fv.text
}

function FilterControl({
  entry,
  filters,
  onFilter,
}: {
  entry: CatalogEntry
  filters: Record<string, FilterVal>
  onFilter: (entry: CatalogEntry, field: Field, patch: FilterVal) => void
}) {
  // The filter always follows what the map is drawing by — read straight off
  // the visible layer's own renderer, so it works for every symbology with
  // no configuration.
  const field = (entry.layer.fields ?? []).find((f) => f.name === entry.filterField)
  const attrLabel =
    entry.symbologies.find((s) => s.id === entry.activeSymbology)?.label ??
    field?.alias ??
    entry.filterField ??
    '—'
  // Filter state is keyed on the catalog entry (the GROUP for a symbology
  // group), so it survives switching between siblings. Only one field is ever
  // filtered at a time; if the live filter belongs to a field we are no longer
  // symbolizing, say so rather than letting it look like nothing is applied.
  const stray = Object.entries(filters).find(
    ([k, v]) => k.startsWith(`${entry.id}|`) && k.slice(entry.id.length + 1) !== field?.name && isActive(v),
  )
  const strayField = stray && (entry.layer.fields ?? []).find((f) => f.name === stray[0].slice(entry.id.length + 1))
  const strayNote = strayField ? (
    <div style={{ font: '400 10.5px/1.4 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>
      Still filtered by {strayField.alias || strayField.name}.{' '}
      <button
        className="sc-link-btn"
        style={{ fontSize: 10.5 }}
        onClick={() => onFilter(entry, strayField, { code: undefined, lo: undefined, hi: undefined, text: '' })}
      >
        Clear
      </button>
    </div>
  ) : null
  if (!field)
    return (
      <>
        <div style={{ font: '400 10.5px/1.4 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>
          {/* Fields arrive with the layer, which loads when the row is switched
              on — say which of the two states this is rather than claiming the
              symbology names no attribute while we are still reading it. */}
          {!entry.ready && entry.filterField
            ? `Reading this layer's fields…`
            : `This layer's symbology does not name a single attribute, so there is nothing to filter by.`}
        </div>
        {strayNote}
      </>
    )
  const key = `${entry.id}|${field.name}`
  const fv = filters[key] ?? {}
  const domain = (field.domain as { codedValues?: { name: string; code: string | number }[] } | null)?.codedValues

  let control: React.ReactNode = null
  let note = ''

  if (domain?.length) {
    note =
      fv.code === undefined || fv.code === '__all'
        ? 'This field publishes a coded-value domain, so the filter is a list.'
        : `Showing features coded ${fv.code}.`
    control = (
      <select
        className="sc-select"
        style={{ height: 28, width: '100%', fontSize: 11.5 }}
        value={fv.code ?? '__all'}
        aria-label={`Filter ${entry.title} by ${attrLabel}`}
        onChange={(e) =>
          onFilter(entry, field, {
            code: e.target.value === '__all' ? undefined : e.target.value,
            lo: undefined,
            hi: undefined,
            text: '',
          })
        }
      >
        <option value="__all">All values ({domain.length})</option>
        {domain.slice(0, 60).map((c: { name: string; code: string | number }) => (
          <option key={String(c.code)} value={String(c.code)}>
            {c.name}
          </option>
        ))}
      </select>
    )
  } else if (/double|single|integer|small-integer|long|oid/.test(field.type ?? '')) {
    const st = numericStats(entry.layer, field)
    if (st.pending || st.failed || typeof st.min !== 'number' || typeof st.max !== 'number') {
      note = st.failed ? 'The value range for this field could not be read.' : 'Reading the value range…'
    } else {
      const pctField = PCT_LIKE.test(field.name)
      const span = st.max - st.min || 1
      const step = span > 50 ? 1 : span > 5 ? 0.1 : 0.01
      const lo = fv.lo ?? st.min
      const hi = fv.hi ?? st.max
      const f = (v: number) => fmtStat(v, pctField, st.max!)
      control = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ position: 'relative', height: 14 }} aria-hidden>
            <div style={{ position: 'absolute', left: 0, right: 0, top: 6, height: 3, background: 'var(--sc-card-border)' }} />
            <div
              style={{
                position: 'absolute',
                top: 6,
                height: 3,
                background: 'var(--sc-blue-deep)',
                left: `${Math.round(((lo - st.min) / span) * 100)}%`,
                right: `${Math.round(((st.max - hi) / span) * 100)}%`,
              }}
            />
          </div>
          {(
            [
              ['Min', lo, (v: number) => onFilter(entry, field, { lo: Math.min(v, hi), hi, code: undefined, text: '' })],
              ['Max', hi, (v: number) => onFilter(entry, field, { hi: Math.max(v, lo), lo, code: undefined, text: '' })],
            ] as const
          ).map(([label, val, set]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 26, flex: 'none', font: '400 10px/1 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>
                {label}
              </div>
              <input
                type="range"
                min={st.min}
                max={st.max}
                step={step}
                value={val}
                aria-label={`${label} ${attrLabel}`}
                onChange={(e) => set(Number(e.target.value))}
                style={{ flex: 1, minWidth: 0 }}
              />
              <div style={{ width: 58, flex: 'none', textAlign: 'right', font: '600 10.5px/1 var(--sc-font)', color: 'var(--sc-text)' }}>
                {f(val)}
              </div>
            </div>
          ))}
        </div>
      )
    }
  } else if (/date/.test(field.type ?? '')) {
    note = 'Date filtering is coming; this field publishes dates.'
  } else {
    note = `Free-text match on ${field.alias || field.name}.`
    control = (
      <input
        value={fv.text ?? ''}
        placeholder="Contains…"
        aria-label={`Filter ${entry.title} by ${attrLabel} text`}
        onChange={(e) => onFilter(entry, field, { text: e.target.value, code: undefined, lo: undefined, hi: undefined })}
        style={{
          height: 28,
          width: '100%',
          border: '1px solid var(--sc-input-border)',
          background: '#fff',
          padding: '0 7px',
          font: '400 11.5px/1 var(--sc-font)',
          color: 'var(--sc-text)',
          borderRadius: 2,
        }}
      />
    )
  }

  return (
    <>
      <div className="sc-overline" style={{ color: '#555', fontSize: 10 }}>
        Filter — {attrLabel}
      </div>
      {control}
      {note && <div style={{ font: '400 10.5px/1.4 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>{note}</div>}
      {strayNote}
    </>
  )
}
