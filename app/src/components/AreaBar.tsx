import { useId, useMemo, useRef, useState } from 'react'
import type Geometry from '@arcgis/core/geometry/Geometry'
import { Icon } from './icons'
import { controller } from '../map/controller'
import type { BoundaryOption } from '../map/controller'
import type { AreaPick } from '../App'

/**
 * Global area filter bar (46px). The area filter governs both tabs and is
 * part of the shareable URL. Combobox follows the WAI-ARIA multi-select
 * pattern with aria-activedescendant keyboard navigation.
 */
export function AreaBar({
  boundaries,
  areas,
  customArea,
  sketchActive,
  onChange,
  vp = 'desktop',
  leading,
}: {
  boundaries: BoundaryOption[]
  areas: AreaPick[]
  customArea: { geometry: Geometry; label: string } | null
  sketchActive: boolean
  onChange: (areas: AreaPick[], custom: { geometry: Geometry; label: string } | null) => void
  vp?: 'desktop' | 'tablet' | 'phone'
  leading?: React.ReactNode
}) {
  const phone = vp === 'phone'
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const [uploadError, setUploadError] = useState('')
  const closeTimer = useRef<number>(0)
  const menuTimer = useRef<number>(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const q = query.trim().toLowerCase()
  const grouped = useMemo(() => {
    const groups: { name: string; options: BoundaryOption[] }[] = []
    for (const b of boundaries) {
      if (q && !b.name.toLowerCase().includes(q) && !b.display.toLowerCase().includes(q)) continue
      let g = groups.find((x) => x.name === b.group)
      if (!g) groups.push((g = { name: b.group, options: [] }))
      g.options.push(b)
    }
    return groups
  }, [boundaries, q])
  const flat = useMemo(() => grouped.flatMap((g) => g.options), [grouped])

  const picked = (name: string) => areas.some((a) => a.name === name)
  const toggle = (o: BoundaryOption) => {
    const next = picked(o.name)
      ? areas.filter((a) => a.name !== o.name)
      : [...areas, { group: o.group, name: o.name }]
    onChange(next, customArea)
    setQuery('')
  }

  const hold = () => window.clearTimeout(closeTimer.current)
  /** Grace period before the suggestion list closes on mouse-out. Long enough
   *  to travel from the input to an option without the list vanishing mid-
   *  reach — 220ms was, and the list is the only way to pick an area. */
  const CLOSE_GRACE_MS = 600
  const releaseSoon = () => {
    hold()
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_GRACE_MS)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActiveIdx((i) => Math.min(flat.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' && open && activeIdx >= 0 && flat[activeIdx]) {
      e.preventDefault()
      toggle(flat[activeIdx])
    } else if (e.key === 'Escape') {
      setOpen(false)
      setActiveIdx(-1)
    }
  }

  const startDraw = () => {
    setMenuOpen(false)
    void controller.drawCustomArea().then((geom) => {
      if (geom) onChange(areas, { geometry: geom, label: 'Drawn area' })
    })
  }

  const onUpload = (file: File) => {
    setUploadError('')
    if (/\.(zip|shp)$/i.test(file.name)) {
      setUploadError('Shapefile upload is coming; upload GeoJSON for now.')
      return
    }
    file
      .text()
      .then((text) => {
        const geom = controller.geoJsonToGeometry(text)
        if (!geom) {
          setUploadError('That file could not be read as polygon GeoJSON.')
          return
        }
        onChange(areas, { geometry: geom, label: file.name })
      })
      .catch(() => setUploadError('That file could not be read.'))
  }

  return (
    <div
      style={{
        height: 46,
        flex: 'none',
        position: 'relative',
        zIndex: 20,
        background: 'var(--sc-ground)',
        borderBottom: '1px solid var(--sc-gray-light)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 16px',
      }}
    >
      {leading}
      {/* Area combobox */}
      <div
        style={{ position: 'relative', flex: phone ? 1 : 'none', minWidth: 0, width: phone ? 'auto' : 326 }}
        onMouseLeave={releaseSoon}
        onMouseEnter={hold}
      >
        <div
          style={{
            height: 32,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 9px',
            borderRadius: 2,
            background: '#fff',
            border: `1px solid ${open ? 'var(--sc-blue-deep)' : 'var(--sc-input-border)'}`,
          }}
        >
          <Icon name="search" style={{ color: 'var(--sc-gray-dark)' }} />
          <input
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIdx >= 0 && flat[activeIdx] ? `${listId}-${activeIdx}` : undefined}
            aria-label="Filter by county"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setOpen(true)
              setActiveIdx(-1)
            }}
            onFocus={() => {
              hold()
              setOpen(true)
            }}
            onClick={() => setOpen(true)}
            onKeyDown={onKey}
            placeholder="Filter by county"
            style={{
              flex: 1,
              minWidth: 0,
              border: 0,
              outline: 'none',
              background: 'transparent',
              font: '400 12.5px/1 var(--sc-font)',
              color: 'var(--sc-text)',
            }}
          />
          {query && (
            <button
              aria-label="Clear area search"
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
        <div
          id={listId}
          role="listbox"
          aria-multiselectable
          aria-label="Boundaries"
          style={{
            display: open ? 'block' : 'none',
            position: 'absolute',
            top: 36,
            left: 0,
            zIndex: 60,
            width: phone ? 'min(326px, 86vw)' : 326,
            maxHeight: 330,
            overflow: 'auto',
            background: '#fff',
            border: '1px solid var(--sc-gray-light)',
            boxShadow: 'var(--sc-shadow-modal)',
          }}
        >
          {grouped.map((g) => (
            <div key={g.name}>
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  background: 'var(--sc-ground)',
                  borderBottom: '1px solid var(--sc-hairline)',
                  padding: '7px 11px',
                }}
                className="sc-overline"
              >
                {g.name}
              </div>
              {g.options.map((o) => {
                const idx = flat.indexOf(o)
                const on = picked(o.name)
                return (
                  <div
                    key={o.group + o.name}
                    id={`${listId}-${idx}`}
                    role="option"
                    aria-selected={on}
                    onClick={() => toggle(o)}
                    onMouseMove={() => setActiveIdx(idx)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 11px',
                      cursor: 'pointer',
                      background: on ? 'var(--sc-surface-blue)' : idx === activeIdx ? 'var(--sc-ground)' : '#fff',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0, font: '400 12px/1.3 var(--sc-font)', color: 'var(--sc-text)' }}>
                      {o.display}
                    </div>
                    {on && <Icon name="check" size={13} style={{ color: 'var(--sc-blue-deep)' }} />}
                  </div>
                )
              })}
            </div>
          ))}
          {!grouped.length && (
            <div style={{ padding: '12px 11px', font: '400 11.5px/1.45 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>
              No boundary matches that search. Try a shorter term, or draw a custom area.
            </div>
          )}
        </div>
      </div>

      <div style={{ width: 1, height: 22, background: 'var(--sc-card-border)' }} />

      {/* Custom area */}
      <div
        style={{ position: 'relative', flex: 'none' }}
        onMouseEnter={() => {
          window.clearTimeout(menuTimer.current)
          setMenuOpen(true)
        }}
        onMouseLeave={() => {
          window.clearTimeout(menuTimer.current)
          menuTimer.current = window.setTimeout(() => setMenuOpen(false), 220)
        }}
      >
        <button
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={phone ? 'Custom area' : undefined}
          onClick={() => setMenuOpen((v) => !v)}
          style={{
            height: 32,
            whiteSpace: 'nowrap',
            padding: '0 10px',
            border: `1px solid ${menuOpen ? 'var(--sc-blue-deep)' : 'var(--sc-input-border)'}`,
            background: menuOpen ? 'var(--sc-surface-blue)' : '#fff',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            font: '400 12.5px/1 var(--sc-font)',
            color: 'var(--sc-text)',
            borderRadius: 2,
          }}
        >
          <Icon name="polygon" style={{ color: 'var(--sc-blue-deep)' }} />
          {!phone && 'Custom area'}
          <Icon name="chevron-right" size={12} style={{ color: '#555', transform: 'rotate(90deg)' }} />
        </button>
        {menuOpen && (
          <div
            role="menu"
            aria-label="Custom area"
            style={{
              position: 'absolute',
              top: 34,
              right: phone ? 0 : 'auto',
              left: phone ? 'auto' : 0,
              zIndex: 60,
              width: 238,
              background: '#fff',
              border: '1px solid var(--sc-gray-light)',
              boxShadow: 'var(--sc-shadow-modal)',
            }}
          >
            <MenuRow icon="polygon" title="Draw an area" desc="Sketch a boundary on the map" onClick={startDraw} />
            <MenuRow
              icon="upload-to"
              title="Upload a shape"
              desc="GeoJSON (shapefile coming)"
              onClick={() => {
                setMenuOpen(false)
                fileRef.current?.click()
              }}
            />
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".geojson,.json,application/geo+json,application/json"
          className="sr-only"
          aria-label="Upload a GeoJSON boundary"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onUpload(f)
            e.target.value = ''
          }}
        />
      </div>

      {/* Chips */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
        {areas.map((a) => (
          <span
            key={a.group + a.name}
            style={{
              height: 24,
              flex: 'none',
              whiteSpace: 'nowrap',
              padding: '0 8px 0 10px',
              background: 'var(--sc-navy)',
              borderRadius: 9999,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              font: '400 11.5px/1 var(--sc-font)',
              color: '#fff',
            }}
          >
            {a.name.split(' — ')[0]}
            <button
              className="on-dark"
              aria-label={`Remove ${a.name}`}
              onClick={() => onChange(areas.filter((x) => x.name !== a.name), customArea)}
              style={{ opacity: 0.75, color: '#fff', fontSize: 13, lineHeight: 1 }}
            >
              ×
            </button>
          </span>
        ))}
        {customArea && (
          <span
            style={{
              height: 24,
              flex: 'none',
              whiteSpace: 'nowrap',
              padding: '0 8px 0 10px',
              background: 'var(--sc-navy)',
              borderRadius: 9999,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              font: '400 11.5px/1 var(--sc-font)',
              color: '#fff',
            }}
          >
            {customArea.label}
            <button
              className="on-dark"
              aria-label="Remove the custom area"
              onClick={() => onChange(areas, null)}
              style={{ opacity: 0.75, color: '#fff', fontSize: 13, lineHeight: 1 }}
            >
              ×
            </button>
          </span>
        )}
        {sketchActive && (
          <span style={{ font: '400 11.5px/1 var(--sc-font)', color: 'var(--sc-blue-deep)' }}>
            Drawing — click to add vertices, double-click to finish, Esc to cancel.
          </span>
        )}
        {uploadError && (
          <span role="alert" style={{ font: '400 11.5px/1 var(--sc-font)', color: 'var(--sc-orange)' }}>
            {uploadError}
          </span>
        )}
        {!areas.length && !customArea && !sketchActive && !uploadError && (
          <span style={{ font: '400 11.5px/1 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>
            Region-wide — no area filter
          </span>
        )}
      </div>
      <div aria-live="polite" className="sr-only">
        {areas.length || customArea
          ? `Area filter: ${[...areas.map((a) => a.name), ...(customArea ? [customArea.label] : [])].join(', ')}`
          : 'Region-wide — no area filter'}
      </div>
    </div>
  )
}

function MenuRow({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: string
  title: string
  desc: string
  onClick: () => void
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '9px 11px',
        width: '100%',
        textAlign: 'left',
        background: '#fff',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--sc-ground)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = '#fff')}
    >
      <Icon name={icon} style={{ color: 'var(--sc-blue-deep)' }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ font: '400 12px/1.2 var(--sc-font)', color: 'var(--sc-text)' }}>{title}</span>
        <span style={{ font: '400 10.5px/1.2 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>{desc}</span>
      </span>
    </button>
  )
}
