/**
 * App header — brand lock-up, the module strip, and the Share and
 * Help actions. Purely presentational: Share/Help are callbacks.
 *
 * The module strip reads as tabs rather than buttons: the active one is filled
 * white against the brand bar. Only Explore exists today; the later-phase
 * modules render disabled so the roadmap is visible.
 */

import { Icon } from './icons'

const headerBtn: React.CSSProperties = {
  height: 32,
  padding: '0 12px',
  border: '1px solid rgba(255,255,255,.5)',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  font: '400 12px/1 var(--sc-font)',
  color: '#fff',
  background: 'transparent',
  borderRadius: 0,
}

export function Header({
  onShare,
  shareCopied,
  onHelp,
  vp = 'desktop',
}: {
  onShare: () => void
  shareCopied: boolean
  onHelp: () => void
  vp?: 'desktop' | 'tablet' | 'phone'
}) {
  const phone = vp === 'phone'
  const tabBase: React.CSSProperties = {
    padding: '0 18px',
    display: 'flex',
    alignItems: 'center',
    fontSize: 12.5,
    lineHeight: 1,
    fontFamily: 'var(--sc-font)',
    border: 0,
    borderRadius: 0,
    height: '100%',
  }
  const soon: React.CSSProperties = {
    ...tabBase,
    background: 'transparent',
    color: 'rgba(255,255,255,.6)',
    fontWeight: 400,
    cursor: 'not-allowed',
  }
  return (
    <header
      className="on-dark"
      style={{
        height: 52,
        flex: 'none',
        background: 'var(--sc-navy)',
        display: 'flex',
        alignItems: 'center',
        gap: phone ? 8 : 16,
        padding: phone ? '0 8px' : '0 16px',
      }}
    >
      {/* The brand lock-up doubles as "start over": a real link to the app's own
          path with the query string dropped, so it reloads clean and clears
          everything the shareable URL carries — area filter, visible layers and
          their symbology.

          Deliberately `location.pathname`, NOT href="/": the app is served from
          a subpath (high-street-consulting.github.io/marc-resiliency-study/), where "/" is the GitHub
          org root, not the app. On the dev server the two are the same thing.

          Being a real link, not a button, middle- and cmd-click open a fresh
          copy — which is the point of it. */}
      <a
        href={location.pathname}
        title="MARC Transportation Resilience Explorer — start over with the default view"
        className="sc-brand"
        style={{ gap: phone ? 8 : 16 }}
      >
        <img src="./marc-logo-white.svg" alt="" style={{ height: 34, width: 'auto', flex: 'none' }} />
        {phone ? (
          // The wordmark is hidden on phone, so the link needs its accessible
          // name from somewhere — this heading is it.
          <h1 className="sr-only">MARC Transportation Resilience Explorer</h1>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <h1
              style={{
                margin: 0,
                font: '600 14px/1.1 var(--sc-font)',
                color: '#fff',
                letterSpacing: '.05em',
              }}
            >
              TRANSPORTATION RESILIENCE EXPLORER
            </h1>
            <div style={{ font: '400 10.5px/1.1 var(--sc-font)', color: 'rgba(255,255,255,.8)' }}>
              Mid-America Regional Council
            </div>
          </div>
        )}
      </a>
      <div
        role="group"
        aria-label="View"
        style={{
          display: 'flex',
          height: 32,
          marginLeft: 14,
          border: '1px solid rgba(255,255,255,.45)',
        }}
      >
        <button
          aria-pressed
          style={{ ...tabBase, background: '#fff', color: 'var(--sc-navy)', fontWeight: 600, cursor: 'default' }}
        >
          Explore
        </button>
        {!phone && (
          <>
            <button disabled title="Coming in a later phase" style={soon}>
              Stranded Zones
            </button>
            <button disabled title="Coming in a later phase" style={soon}>
              Project Scoring
            </button>
          </>
        )}
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          style={{ ...headerBtn, padding: phone ? '0 9px' : '0 12px' }}
          onClick={onShare}
          aria-label={phone ? (shareCopied ? 'Link copied' : 'Share') : undefined}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,.08)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <Icon name="link" />
          {!phone && (shareCopied ? 'Link copied' : 'Share')}
        </button>
        <button
          style={{ ...headerBtn, padding: phone ? '0 9px' : '0 12px' }}
          onClick={onHelp}
          aria-label={phone ? 'Help' : undefined}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,.08)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <Icon name="question" />
          {!phone && 'Help'}
        </button>
      </div>
      <div aria-live="polite" className="sr-only">
        {shareCopied ? 'Link copied to the clipboard' : ''}
      </div>
    </header>
  )
}