import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { HELP } from '../config/registry'
import { controller } from '../map/controller'

/** Help dialog — description, links and resources
 *  (parity with 1.0), plus map image export. */
export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<'description' | 'links'>('description')

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  const exportMap = () => {
    void controller.takeScreenshot().then((url) => {
      if (!url) return
      const a = document.createElement('a')
      a.href = url
      a.download = 'marc-resilience-map.png'
      a.click()
    })
  }

  const tabBtn = (id: typeof tab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      style={{
        padding: '10px 14px',
        font: `${tab === id ? 600 : 400} 12.5px/1 var(--sc-font)`,
        color: tab === id ? 'var(--sc-blue-deep)' : 'var(--sc-text)',
        borderBottom: `2px solid ${tab === id ? 'var(--sc-blue-deep)' : 'transparent'}`,
      }}
    >
      {label}
    </button>
  )

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      aria-label="MARC Transportation Resilience Explorer help and information"
      style={{
        width: 'min(720px, 94vw)',
        maxHeight: '86vh',
        background: '#fff',
        border: 0,
        padding: 0,
        boxShadow: 'var(--sc-shadow-modal)',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '14px 16px 0',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <div>
          <h2 style={{ margin: 0, font: '600 15px/1.3 var(--sc-font)', color: 'var(--sc-text)' }}>
            Transportation Resilience Explorer — help and information
          </h2>
        </div>
        <button
          aria-label="Close help"
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
      <div role="tablist" aria-label="Help sections" style={{ display: 'flex', gap: 4, padding: '6px 16px 0', borderBottom: '1px solid var(--sc-hairline)' }}>
        {tabBtn('description', 'Explorer description')}
        {tabBtn('links', 'Links and resources')}
      </div>
      <div style={{ padding: 16, minHeight: 280 }}>
        {tab === 'description' && (
          <p style={{ margin: 0, font: '400 12.5px/1.65 var(--sc-font)', color: 'var(--sc-text)' }}>{HELP.description}</p>
        )}
        {tab === 'links' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {HELP.links.map((l) => (
                <li key={l.href} style={{ font: '400 12.5px/1.5 var(--sc-font)', marginBottom: 7 }}>
                  <a href={l.href} target="_blank" rel="noreferrer">
                    {l.label}
                  </a>
                  {'note' in l && l.note && (
                    <div style={{ font: '400 11px/1.4 var(--sc-font)', color: 'var(--sc-gray-dark)' }}>{l.note}</div>
                  )}
                </li>
              ))}
            </ul>
            <div style={{ borderTop: '1px solid var(--sc-hairline)', paddingTop: 12 }}>
              <button className="sc-btn" onClick={exportMap}>
                Export the current map as an image
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  )
}
