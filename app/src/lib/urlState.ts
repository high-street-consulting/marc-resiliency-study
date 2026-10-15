/**
 * Shareable URL state (FR-6): area filter, visible layers with their
 * chosen symbology.
 * Encoded in the query string via history.replaceState (debounced by App).
 *
 * Symbology is authored in the web map as exclusive group layers, so the
 * "which symbology" half of the state is simply which child layer is visible.
 * Unknown ids (an old link, a layer since removed) are ignored on restore.
 */

export interface UrlState {
  areas: { group: string; name: string }[]
  /** Catalog entry ids: a group layer's id, or a plain layer's id. */
  visible: string[]
  /** Catalog entry id → visible child layer id (the chosen symbology). */
  attrs: Record<string, string>
  threshold?: number
  tab?: 'explore' | 'zones'
}

export function encodeState(s: UrlState): string {
  const p = new URLSearchParams()
  if (s.areas.length) p.set('area', s.areas.map((a) => `${a.group}~${a.name}`).join('|'))
  if (s.visible.length) p.set('on', s.visible.join('|'))
  const attrs = Object.entries(s.attrs)
  if (attrs.length) p.set('sym', attrs.map(([k, v]) => `${k}~${v}`).join('|'))
  if (s.threshold !== undefined) p.set('thr', String(s.threshold))
  if (s.tab === 'zones') p.set('tab', s.tab)
  const q = p.toString()
  return q ? '?' + q : ''
}

export function decodeState(search: string): Partial<UrlState> {
  const p = new URLSearchParams(search)
  const out: Partial<UrlState> = {}
  const area = p.get('area')
  if (area)
    out.areas = area
      .split('|')
      .map((x) => {
        const i = x.indexOf('~')
        return i > 0 ? { group: x.slice(0, i), name: x.slice(i + 1) } : null
      })
      .filter((x): x is { group: string; name: string } => !!x)
  const on = p.get('on')
  if (on) out.visible = on.split('|').filter(Boolean)
  const sym = p.get('sym')
  if (sym) {
    out.attrs = {}
    for (const pair of sym.split('|')) {
      const i = pair.indexOf('~')
      if (i > 0) out.attrs[pair.slice(0, i)] = pair.slice(i + 1)
    }
  }
  const thr = p.get('thr')
  if (thr && !Number.isNaN(Number(thr))) out.threshold = Number(thr)
  const tab = p.get('tab')
  if (tab === 'zones' || tab === 'explore') out.tab = tab
  return out
}