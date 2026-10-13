import { useEffect, useMemo, useState } from 'react'
import { Icon } from './icons'
import type { CatalogEntry } from '../map/controller'
import { SKIP_FIELDS } from '../config/registry'
import { fmt } from '../lib/format'

const PAGE = 50

/** Attribute table (FR-1) — a docked bottom rail, not a modal. Toggleable
 *  for any layer; the select switches layers in place. */
export function TablePanel({
  open,
  onClose,
  layers,
  layerId,
  onLayerId,
}: {
  open: boolean
  onClose: () => void
  layers: CatalogEntry[]
  layerId: string | null
  onLayerId: (id: string) => void
}) {
  const entry = layers.find((l) => l.id === layerId) ?? layers[0]
  const layer = entry?.layer ?? null
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [fields, setFields] = useState<{ name: string; label: string }[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [page, setPage] = useState(0)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [sort, setSort] = useState<{ field: string; desc: boolean } | null>(null)

  const sections = useMemo(() => {
    const out: { name: string; entries: CatalogEntry[] }[] = []
    for (const l of layers) {
      let s = out.find((x) => x.name === l.section)
      if (!s) out.push((s = { name: l.section, entries: [] }))
      s.entries.push(l)
    }
    return out
  }, [layers])

  useEffect(() => {
    setPage(0)
    setSort(null)
  }, [layerId])

  useEffect(() => {
    if (!open || !layer) return
    let cancelled = false
    setState('loading')
    const run = async () => {
      try {
        await layer.load()
        const fl = (layer.fields ?? [])
          .filter((f) => !SKIP_FIELDS.test(f.name))
          .map((f) => ({ name: f.name, label: f.alias || f.name }))
        const count = await layer.queryFeatureCount({ where: layer.definitionExpression || '1=1' } as any)
        const res = await layer.queryFeatures({
          where: layer.definitionExpression || '1=1',
          outFields: fl.map((f) => f.name),
          returnGeometry: false,
          start: page * PAGE,
          num: PAGE,
          orderByFields: [sort ? `${sort.field} ${sort.desc ? 'DESC' : 'ASC'}` : layer.objectIdField],
        } as any)
        if (cancelled) return
        setFields(fl)
        setTotal(count)
        setRows(res.features.map((f) => f.attributes as Record<string, unknown>))
        setState('idle')
      } catch {
        if (!cancelled) setState('error')
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [open, layer, page, sort])

  if (!open) return null
  const pages = total !== null ? Math.max(1, Math.ceil(total / PAGE)) : 1

  return (
    <section
      aria-label={`Attribute table: ${entry?.title ?? ''}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      style={{
        flex: 'none',
        height: 'min(320px, 42vh)',
        borderTop: '1px solid var(--sc-gray-light)',
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div
        style={{
          height: 40,
          flex: 'none',
          borderBottom: '1px solid var(--sc-hairline)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 12px',
          flexWrap: 'wrap',
        }}
      >
        <span className="sc-overline">Attribute table</span>
        <select
          className="sc-select"
          style={{ height: 28, fontSize: 11.5, maxWidth: 'min(320px, 40vw)' }}
          aria-label="Table layer"
          value={entry?.id ?? ''}
          onChange={(e) => onLayerId(e.target.value)}
        >
          {sections.map((s) => (
            <optgroup key={s.name} label={s.name}>
              {s.entries.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span style={{ font: '400 11px/1 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>
          {total !== null ? `${total.toLocaleString()} features` : ''}
        </span>
        <div style={{ flex: 1 }} />
        <button className="sc-btn sc-btn--small" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          Previous
        </button>
        <span style={{ font: '400 11px/1 var(--sc-font)', color: 'var(--sc-text-mid)' }}>
          Page {page + 1} of {pages}
        </span>
        <button
          className="sc-btn sc-btn--small"
          disabled={page + 1 >= pages}
          onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
        >
          Next
        </button>
        <button
          aria-label="Close attribute table"
          onClick={onClose}
          style={{
            width: 28,
            height: 28,
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
        {state === 'error' && (
          <div className="sc-error" style={{ margin: 12 }}>
            <b>The table could not be read</b>
            <span>The layer did not return rows. Try another layer, or open the layer's metadata.</span>
          </div>
        )}
        {state === 'loading' && (
          <div style={{ padding: 12, font: '400 12px/1.5 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>
            Reading features…
          </div>
        )}
        {state === 'idle' && (
          <table style={{ borderCollapse: 'collapse', width: '100%', font: '400 11.5px/1.4 var(--sc-font)' }}>
            <thead>
              <tr>
                {fields.map((f) => {
                  const sorted = sort?.field === f.name
                  return (
                    <th
                      key={f.name}
                      scope="col"
                      aria-sort={sorted ? (sort!.desc ? 'descending' : 'ascending') : undefined}
                      style={{
                        position: 'sticky',
                        top: 0,
                        background: 'var(--sc-ground)',
                        borderBottom: '1px solid var(--sc-gray-light)',
                        padding: 0,
                        textAlign: 'left',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <button
                        onClick={() =>
                          setSort(sorted ? { field: f.name, desc: !sort!.desc } : { field: f.name, desc: false })
                        }
                        style={{
                          font: '600 10.5px/1.2 var(--sc-font)',
                          color: sorted ? 'var(--sc-blue-deep)' : 'var(--sc-text-mid)',
                          padding: '7px 10px',
                          width: '100%',
                          textAlign: 'left',
                        }}
                      >
                        {f.label}
                        {sorted ? (sort!.desc ? ' ↓' : ' ↑') : ''}
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--sc-track)' }}>
                  {fields.map((f) => (
                    <td
                      key={f.name}
                      style={{
                        padding: '5px 10px',
                        whiteSpace: 'nowrap',
                        maxWidth: 260,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {fmt(r[f.name], f.name)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
