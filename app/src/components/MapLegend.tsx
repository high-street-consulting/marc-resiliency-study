import type { RefObject } from 'react'
import { Icon } from './icons'

// Legend card — reflects the visible layers' actual renderers.
export function MapLegend({
  legendRef,
  open,
  onToggle,
  onOpenTable,
}: {
  legendRef: RefObject<HTMLDivElement | null>
  open: boolean
  onToggle: () => void
  onOpenTable: () => void
}) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 34,
        left: 12,
        background: '#fff',
        border: '1px solid var(--sc-gray-light)',
        padding: '10px 11px',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        boxShadow: 'var(--sc-shadow-card)',
        minWidth: open ? 196 : 0,
        maxWidth: 'min(260px, 70vw)',
        maxHeight: 'calc(100% - 46px)',
      }}
    >
      <button
        aria-expanded={open}
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' }}
      >
        <span style={{ font: '600 12px/1.2 var(--sc-font)', color: 'var(--sc-text)' }}>Legend</span>
        <Icon name="chevron-right" size={12} style={{ color: '#555', transform: open ? 'rotate(90deg)' : 'none' }} />
      </button>
      <div ref={legendRef} className="sc-live-legend" style={{ display: open ? 'block' : 'none' }} />
      {open && (
        <button className="sc-link-btn" style={{ textAlign: 'left' }} onClick={onOpenTable}>
          Attribute table
        </button>
      )}
    </div>
  )
}
