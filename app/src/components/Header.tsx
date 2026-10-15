/**
 * App header styled after marc.org: the four-band stripe, a white bar with the
 * colour MARC logo, the module tabs as uppercase nav items (Explore and the
 * Stranded Zones view), and Help as outline brand
 * buttons. Purely presentational.
 */

import { Icon } from './icons'
import marcLogo from '../assets/marc-logo-color.svg'

const headerBtn: React.CSSProperties = {
  height: 32,
  padding: '0 12px',
  border: '1px solid var(--sc-navy)',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  font: '500 11.5px/1 var(--sc-font)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  color: 'var(--sc-navy)',
  background: 'transparent',
  borderRadius: 0,
}

export function Header({
  tab,
  onTab,
  onHelp,
  onMethodology,
  vp = 'desktop',
}: {
  tab: 'explore' | 'zones'
  onTab: (tab: 'explore' | 'zones') => void
  onHelp: () => void
  onMethodology: () => void
  vp?: 'desktop' | 'tablet' | 'phone'
}) {
  const phone = vp === 'phone'
  const navItem: React.CSSProperties = {
    padding: '0 12px',
    display: 'flex',
    alignItems: 'center',
    height: '100%',
    font: '500 13px/1 var(--sc-font)',
    textTransform: 'uppercase',
    letterSpacing: '.03em',
    border: 0,
    borderBottom: '3px solid transparent',
    borderRadius: 0,
    background: 'transparent',
    color: '#1a1a1a',
  }
  const current: React.CSSProperties = { ...navItem, color: 'var(--sc-navy)', borderBottomColor: 'var(--sc-navy)', fontWeight: 700 }
  const hover = (on: boolean) => (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = on ? 'var(--sc-navy)' : 'transparent'
    e.currentTarget.style.color = on ? '#fff' : 'var(--sc-navy)'
  }
  return (
    <>
      <div className="marc-bands" aria-hidden />
      <header
        style={{
          height: 60,
          flex: 'none',
          background: '#fff',
          borderBottom: '1px solid var(--sc-hairline)',
          display: 'flex',
          alignItems: 'stretch',
          gap: phone ? 8 : 16,
          padding: phone ? '0 8px' : '0 16px',
        }}
      >
        {/* The brand lock-up doubles as "start over": a real link to the app's own
            path with the query string dropped. Deliberately `location.pathname`,
            not "/", because the app is served from a subpath on GitHub Pages. */}
        <a
          href={location.pathname}
          title="MARC Transportation Resilience Explorer — start over with the default view"
          className="sc-brand"
          style={{ gap: phone ? 8 : 14 }}
        >
          <img src={marcLogo} alt="" style={{ height: 44, width: 'auto', flex: 'none' }} />
          {phone ? (
            <h1 className="sr-only">MARC Transportation Resilience Explorer</h1>
          ) : (
            <h1
              style={{
                margin: 0,
                paddingLeft: 14,
                borderLeft: '1px solid var(--sc-hairline)',
                font: '600 13px/1.2 var(--sc-font)',
                color: 'var(--sc-navy)',
                letterSpacing: '.06em',
                textTransform: 'uppercase',
              }}
            >
              Transportation Resilience Explorer
            </h1>
          )}
        </a>
        <nav aria-label="Modules" style={{ display: 'flex', marginLeft: phone ? 0 : 8 }}>
          <button
            aria-current={tab === 'explore' ? 'page' : undefined}
            title="Explore the study layers"
            style={tab === 'explore' ? current : navItem}
            onClick={() => onTab('explore')}
          >
            Explore
          </button>
          {!phone && (
            <>
              <button
                aria-current={tab === 'zones' ? 'page' : undefined}
                title="Flood scenario: stranded zones and closed segments"
                style={tab === 'zones' ? current : navItem}
                onClick={() => onTab('zones')}
              >
                Stranded Zones
              </button>
            </>
          )}
        </nav>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            style={{ ...headerBtn, padding: phone ? '0 9px' : '0 12px' }}
            onClick={onMethodology}
            aria-label={phone ? 'Methodology' : undefined}
            onMouseEnter={hover(true)}
            onMouseLeave={hover(false)}
          >
            <Icon name="file-report" />
            {!phone && 'Methodology'}
          </button>
          <button
            style={{ ...headerBtn, padding: phone ? '0 9px' : '0 12px' }}
            onClick={onHelp}
            aria-label={phone ? 'Help' : undefined}
            onMouseEnter={hover(true)}
            onMouseLeave={hover(false)}
          >
            <Icon name="question" />
            {!phone && 'Help'}
          </button>
        </div>
      </header>
    </>
  )
}
