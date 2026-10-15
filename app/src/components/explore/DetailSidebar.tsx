import { useMemo } from 'react'
import type Field from '@arcgis/core/layers/support/Field'
import { Icon } from '../icons'
import type { SelectedFeature } from '../../map/controller'
import { controller } from '../../map/controller'
import { ID_LIKE, PCT_LIKE, SKIP_FIELDS } from '../../config/registry'
import { categoryStats, numericStats, useStatsVersion } from '../../lib/stats'
import { fmt, plural } from '../../lib/format'

/**
 * Feature detail sidebar — 360px, shown only when a feature is selected;
 * replaces the Esri popup, which we do not use anywhere.
 *
 * Everything shown is derived from the clicked feature's own fields: the title
 * from the first name-like string field, the headline stat from whichever
 * attribute the layer is symbolized by (so the pane agrees with the map), coded
 * domains resolved to their labels, and each value put in context against the
 * layer's statistics. No field is named in code — see the registry's
 * `SKIP_FIELDS` / `ID_LIKE` / `PCT_LIKE` patterns for the classification rules.
 */
export function DetailSidebar({
  selected,
  activeAttrField,
  onClose,
  onOpenTable,
  onOpenZones,
}: {
  selected: SelectedFeature
  activeAttrField: string | undefined
  onClose: () => void
  onOpenTable: () => void
  onOpenZones?: () => void
}) {
  useStatsVersion()
  const sel = selected

  const list = useMemo(() => {
    const fields = (sel.fields ?? []).filter((f) => !SKIP_FIELDS.test(f.name) && sel.attrs[f.name] !== undefined)
    return fields.length
      ? fields.map((f) => ({ name: f.name, label: f.alias || f.name, type: f.type as string }))
      : Object.keys(sel.attrs)
          .filter((k) => !SKIP_FIELDS.test(k))
          .map((k) => ({ name: k, label: k, type: typeof sel.attrs[k] === 'number' ? 'double' : 'string' }))
  }, [sel])

  const isNum = (name: string) => typeof sel.attrs[name] === 'number'
  const domainOf = (name: string) => {
    const fl = (sel.fields ?? []).find((x) => x.name === name)
    return (fl?.domain as { codedValues?: { name: string; code: string | number }[] } | null)?.codedValues ?? null
  }
  const coded = (name: string, v: unknown): string | null => {
    const d = domainOf(name)
    if (!d) return null
    const m = d.find((c: { name: string; code: string | number }) => String(c.code) === String(v))
    return m ? m.name : null
  }
  const isCat = (e: { name: string }) =>
    !!domainOf(e.name) ||
    (typeof sel.attrs[e.name] === 'string' && String(sel.attrs[e.name]).length < 40 && !ID_LIKE.test(e.name))

  const strings = list.filter((e) => !isNum(e.name) && typeof sel.attrs[e.name] === 'string' && String(sel.attrs[e.name]).trim())
  const titleField =
    strings.find((e) => /name|route|street|road|corridor|project|title|label/i.test(e.name)) ?? strings[0]
  const title = titleField ? String(sel.attrs[titleField.name]) : `${sel.layerTitle} feature`

  const activeEntry = list.find((e) => e.name === activeAttrField)
  const headEntry =
    activeEntry && (isNum(activeEntry.name) || isCat(activeEntry)) && !ID_LIKE.test(activeEntry.name)
      ? activeEntry
      : (list.find((e) => !ID_LIKE.test(e.name) && (isNum(e.name) || isCat(e))) ?? null)

  const fieldMeta = (name: string): Field | undefined => (sel.fields ?? []).find((x) => x.name === name)

  /* headline visual */
  let headline: React.ReactNode = null
  let headlineNote = ''
  let headlineValue = ''
  if (headEntry && isCat(headEntry)) {
    const fl = fieldMeta(headEntry.name)
    const cats = fl ? categoryStats(sel.layer, fl) : { failed: true as const }
    const raw = sel.attrs[headEntry.name]
    headlineValue = coded(headEntry.name, raw) ?? String(raw ?? '(no value)')
    const allRows = ('rows' in cats && cats.rows) || []
    const uninformative = allRows.length > 0 && allRows.every((r) => r.count === 1)
    const rows = uninformative ? [] : allRows.slice(0, 8)
    const top = rows.reduce((a, r) => Math.max(a, r.count), 1)
    const total = allRows.reduce((a, r) => a + r.count, 0)
    const thisRow = allRows.find((r) => String(r.code) === String(raw))
    const catLabel = (v: unknown) =>
      coded(headEntry.name, v) ?? (v === null || v === undefined || v === '' ? '(no value)' : String(v))
    headlineNote =
      'pending' in cats && cats.pending
        ? 'Reading the distribution…'
        : 'failed' in cats && cats.failed
          ? 'The distribution for this field could not be read.'
          : uninformative
            ? 'Every feature carries a distinct value for this field, so there is no distribution to show.'
            : thisRow
              ? `This feature is 1 of ${thisRow.count.toLocaleString()} features in ${catLabel(raw)}, out of ${total.toLocaleString()} in the layer.`
              : `Distribution of the ${allRows.length} values in this layer.`
    headline = rows.length ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="sc-overline" style={{ color: 'var(--sc-blue-deep)', fontSize: 9 }}>
          Distribution across the layer
        </div>
        {rows.map((r) => {
          const on = String(r.code) === String(sel.attrs[headEntry.name])
          const pct = Math.max(2, Math.round((r.count / top) * 100))
          return (
            <div key={String(r.code)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  font: `${on ? 600 : 400} 10.5px/1.25 var(--sc-font)`,
                  color: 'var(--sc-text)',
                  overflowWrap: 'anywhere',
                }}
              >
                {catLabel(r.code)}
              </div>
              <div
                style={{ width: 104, flex: 'none', height: 9, background: '#fff', border: '1px solid var(--sc-surface-blue-border)' }}
              >
                <div style={{ height: '100%', background: on ? 'var(--sc-navy)' : 'var(--sc-blue-60)', width: `${pct}%` }} />
              </div>
              <div style={{ width: 38, flex: 'none', textAlign: 'right', font: '400 9.5px/1 var(--sc-font)', color: 'var(--sc-text-mid)' }}>
                {r.count.toLocaleString()}
              </div>
            </div>
          )
        })}
      </div>
    ) : null
  } else if (headEntry) {
    const v = sel.attrs[headEntry.name] as number
    const fl = fieldMeta(headEntry.name)
    const stx = fl ? numericStats(sel.layer, fl) : { failed: true as const }
    headlineValue = fmt(v, headEntry.name)
    if ('min' in stx && typeof stx.min === 'number' && stx.max !== stx.min && typeof stx.max === 'number') {
      const span = stx.max - stx.min
      const pct = Math.min(98, Math.max(2, Math.round(((v - stx.min) / span) * 100)))
      const avgPct =
        typeof stx.avg === 'number' ? Math.min(98, Math.max(2, Math.round(((stx.avg - stx.min) / span) * 100))) : null
      headlineNote = `Position within the layer range; the orange tick is the layer average (${fmt(stx.avg, headEntry.name)}).`
      headline = (
        <>
          <div
            role="img"
            aria-label={`${headlineValue} on a scale from ${fmt(stx.min)} to ${fmt(stx.max)}; layer average ${fmt(stx.avg)}`}
            style={{ height: 13, background: '#fff', border: '1px solid var(--sc-surface-blue-border)', position: 'relative' }}
          >
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, background: 'var(--sc-blue-60)', width: `${pct}%` }} />
            <div style={{ position: 'absolute', top: -3, bottom: -3, width: 3, background: 'var(--sc-navy)', left: `${pct}%` }} />
            {avgPct !== null && (
              <div style={{ position: 'absolute', top: -3, bottom: -3, width: 2, background: 'var(--sc-orange)', left: `${avgPct}%` }} />
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', font: '400 9.5px/1 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>
            <span>{fmt(stx.min, headEntry.name)}</span>
            <span>{fmt(stx.max, headEntry.name)}</span>
          </div>
        </>
      )
    } else {
      headlineNote = 'pending' in stx && stx.pending ? 'Reading the value range…' : 'No range published for this field.'
    }
  }

  const rows = list.filter((e) => !headEntry || e.name !== headEntry.name)

  const fieldCount = rows.length + (headEntry ? 1 : 0)

  return (
    <aside
      aria-label={`Feature detail: ${title}`}
      style={{
        width: 360,
        flex: 'none',
        borderLeft: '1px solid var(--sc-gray-light)',
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div
        style={{
          flex: 'none',
          padding: '12px 14px 11px',
          borderBottom: '1px solid var(--sc-card-border)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
        }}
      >
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h2 style={{ margin: 0, font: '600 15px/1.25 var(--sc-font)', color: 'var(--sc-text)' }}>{title}</h2>
          <div style={{ font: '400 11.5px/1.4 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>{sel.layerTitle}</div>
        </div>
        <button
          aria-label="Close feature detail"
          onClick={onClose}
          style={{
            width: 28,
            height: 28,
            flex: 'none',
            border: '1px solid var(--sc-input-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 2,
            color: '#555',
          }}
        >
          <Icon name="x" />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {!headEntry && rows.length === 0 && (
          <div className="sc-notice" style={{ margin: '12px 14px' }}>
            <b style={{ font: '600 12px/1.3 var(--sc-font)' }}>No visualizable attributes</b>
            <span style={{ font: '400 11.5px/1.45 var(--sc-font)', color: 'var(--sc-text-mid)' }}>
              This layer publishes no fields for this feature beyond its identifiers. Open the attribute table to see
              the raw record.
            </span>
          </div>
        )}
        {headEntry && (
          <div
            style={{
              padding: '12px 14px',
              background: 'var(--sc-surface-blue)',
              borderBottom: '1px solid var(--sc-surface-blue-border)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <div className="sc-overline" style={{ color: 'var(--sc-blue-deep)' }}>
                Symbolized attribute
              </div>
              <div style={{ font: '400 10.5px/1 var(--sc-font)', color: 'var(--sc-text-mid)' }}>across this layer</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
              <div style={{ font: '600 28px/1 var(--sc-font)', color: 'var(--sc-navy)' }}>{headlineValue}</div>
              <div style={{ font: '400 12px/1.25 var(--sc-font)', color: 'var(--sc-text)' }}>{headEntry.label}</div>
            </div>
            {headline}
            <div style={{ font: '400 10.5px/1.45 var(--sc-font)', color: 'var(--sc-text-mid)' }}>{headlineNote}</div>
          </div>
        )}
        <div
          style={{
            padding: '10px 14px 6px',
            background: 'var(--sc-ground)',
            borderBottom: '1px solid var(--sc-hairline)',
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
          }}
        >
          <div className="sc-overline">{sel.layerTitle}</div>
          <div style={{ font: '400 10px/1 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>{plural(fieldCount, 'field')}</div>
        </div>
        <div style={{ padding: '11px 14px', display: 'flex', flexDirection: 'column', gap: 11 }}>
          {rows.map((e) => {
            const v = sel.attrs[e.name]
            const dv = coded(e.name, v)
            const idish = ID_LIKE.test(e.name)
            const pctish =
              PCT_LIKE.test(e.name) || (typeof v === 'number' && v >= 0 && v <= 1 && !Number.isInteger(v))
            let value: React.ReactNode
            let meter: React.ReactNode = null
            if (dv !== null) {
              value = <span className="sc-pill">{dv}</span>
            } else if (typeof v === 'string') {
              value =
                v.length <= 28 ? (
                  <span className="sc-pill">{v}</span>
                ) : (
                  <span style={{ font: '600 11.5px/1.2 var(--sc-font)', color: 'var(--sc-text)', flex: 'none', textAlign: 'right', maxWidth: 160, overflowWrap: 'anywhere' }}>
                    {v}
                  </span>
                )
            } else if (/date/i.test(e.type ?? '') && typeof v === 'number') {
              value = (
                <span style={{ font: '600 11.5px/1.2 var(--sc-font)', color: 'var(--sc-text)' }}>
                  {new Date(v).toLocaleDateString()}
                </span>
              )
            } else if (typeof v === 'number' && !idish && pctish) {
              const p = Math.max(1, Math.min(100, Math.round(v <= 1.5 ? v * 100 : v)))
              value = <span style={{ font: '600 11.5px/1.2 var(--sc-font)', color: 'var(--sc-text)', flex: 'none' }}>{p}%</span>
              meter = (
                <div className="sc-meter" aria-hidden>
                  <div style={{ width: `${p}%` }} />
                </div>
              )
            } else {
              value = (
                <span style={{ font: '600 11.5px/1.2 var(--sc-font)', color: 'var(--sc-text)', flex: 'none', textAlign: 'right', maxWidth: 160, overflowWrap: 'anywhere' }}>
                  {fmt(v, e.name)}
                </span>
              )
            }
            return (
              <div key={e.name} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ font: '400 11.5px/1.3 var(--sc-font)', color: 'var(--sc-text-mid)' }}>{e.label}</div>
                  {value}
                </div>
                {meter}
              </div>
            )
          })}
        </div>
      </div>

      <div
        style={{
          flex: 'none',
          borderTop: '1px solid var(--sc-card-border)',
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <button
          className="sc-btn sc-btn--small"
          onClick={() => {
            const id = sel.layer.portalItem?.id
            if (id) window.open(`https://www.arcgis.com/home/item.html?id=${id}`, '_blank')
            else onOpenTable()
          }}
        >
          Metadata
        </button>
        <button
          className="sc-btn sc-btn--small"
          onClick={() => controller.zoomTo(sel.geometry)}
        >
          Zoom to
        </button>
        {onOpenZones && (
          <>
            <div style={{ flex: 1 }} />
            <button className="sc-link-btn" onClick={onOpenZones}>
              Open in Stranded Zones
            </button>
          </>
        )}
      </div>
    </aside>
  )
}
