/**
 * Viewport class as a React hook, driven by matchMedia rather than resize
 * events so it costs nothing between breakpoint crossings.
 *
 * Desktop is the designed target (min-width 1280 per the approved scope);
 * tablet and phone layouts are partial, so components branch on this to drop
 * to a single column and move the catalog into a drawer.
 */

import { useSyncExternalStore } from 'react'

export type Viewport = 'desktop' | 'tablet' | 'phone'

const tabletQ = window.matchMedia('(max-width: 1023px)')
const phoneQ = window.matchMedia('(max-width: 667px)')

function subscribe(fn: () => void): () => void {
  tabletQ.addEventListener('change', fn)
  phoneQ.addEventListener('change', fn)
  return () => {
    tabletQ.removeEventListener('change', fn)
    phoneQ.removeEventListener('change', fn)
  }
}

function get(): Viewport {
  if (phoneQ.matches) return 'phone'
  if (tabletQ.matches) return 'tablet'
  return 'desktop'
}

/** Current viewport class — desktop ≥1024, tablet 668–1023, phone ≤667. */
export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, get)
}
