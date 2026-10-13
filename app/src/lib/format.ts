/** Value formatting shared across the app (ported from the hi-fi prototype). */

/** Format any attribute value for display: em dash for empty, thousands
 *  separators above 1000, at most 2 decimals below it, long strings truncated.
 *  `fieldName` only matters for date/year fields, which must not get separators. */
export function fmt(v: unknown, fieldName?: string): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'number') {
    if (fieldName && /date|year/i.test(fieldName)) return String(v)
    return Math.abs(v) >= 1000
      ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : Number(v.toFixed(2)).toString()
  }
  if (typeof v === 'string' && v.length > 34) return v.slice(0, 32) + '…'
  return String(v)
}

/** Format a stat value, as % when the field is percent-like with a 0–1 span. */
export function fmtStat(v: number, pctLike: boolean, max: number): string {
  if (pctLike && max <= 1.5) return (v * 100).toFixed(0) + '%'
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)
}

/** Clamp a 0–1-or-0–100 value onto 0–100. */
export function scale100(v: number): number {
  return Math.max(0, Math.min(100, v <= 1 ? v * 100 : v))
}

/** "1 segment" / "4 segments" — naive -s plural, adequate for our units. */
export function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}
