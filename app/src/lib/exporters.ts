import marcLogo from '../assets/marc-logo-color.svg'
import { ATTRIBUTION } from '../config/registry'
import type { Story } from './zones'
import { mi, n0 } from './zones'

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'analysis'
  )
}

export function downloadCsv(rows: Record<string, unknown>[], fields: string[], filename: string): void {
  const lines = [fields.join(',')]
  for (const row of rows) lines.push(fields.map((f) => csvCell(row[f])).join(','))
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export function openReport(opts: {
  scenario: string
  thresholdFt: number | null
  areaLabel: string
  story: Story
  aliases: Record<string, string>
  mapDataUrl: string | null
}): void {
  const { scenario, thresholdFt, areaLabel, story: st, aliases, mapDataUrl } = opts
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const al = (f: string) => esc(aliases[f] || f)
  const pct = (v: unknown) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—')
  const now = new Date().toLocaleString()
  const big = (value: string, label: string, note: string) =>
    `<div class="big"><span class="v">${esc(value)}</span> <span class="l">${esc(label)}</span><div class="n">${esc(note)}</div></div>`
  const topRows = st.top
    .slice(0, 10)
    .map((z) => {
      const a = z.graphic.attributes
      return `<tr><td>${esc(String(z.id))}</td><td>${esc(String(z.type))}</td><td class="num">${n0(z.population)}</td><td class="num">${n0(z.jobs)}</td><td class="num">${n0(z.facilities)}</td><td class="num">${mi(z.miles)}</td><td class="num">${pct(a.elderly_share)}</td><td class="num">${pct(a.mobility_disab_share)}</td></tr>`
    })
    .join('')
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Stranded zones report — ${esc(scenario)}</title>
<style>
  body{font:13px/1.5 Roboto,"Segoe UI",system-ui,sans-serif;color:#141414;margin:32px;max-width:760px}
  h1{font-size:20px;margin:0 0 2px;color:#b30838} h2{font-size:14px;margin:22px 0 8px;color:#b30838}
  .sub{color:#7F8084;font-size:11.5px;margin-bottom:18px}
  .big{margin:10px 0} .big .v{font-size:30px;font-weight:600} .big .l{font-size:13px} .big .n{color:#555;font-size:11.5px}
  table{border-collapse:collapse;width:100%;margin-top:6px}
  th,td{border-bottom:1px solid #e6e6e6;text-align:left;padding:5px 8px 5px 0;font-size:12px}
  th{color:#7F8084;font-weight:600;text-transform:uppercase;font-size:9.5px;letter-spacing:.07em}
  td.num,th.num{text-align:right}
  img.map{width:100%;border:1px solid #ACACAD;margin-top:8px}
  .foot{margin-top:28px;color:#7F8084;font-size:10px;border-top:1px solid #e6e6e6;padding-top:10px}
  @media print {.noprint{display:none}}
</style></head><body>
  <button class="noprint" onclick="window.print()" style="float:right">Print or save as PDF</button>
  <img src="${new URL(marcLogo, location.href).href}" alt="Mid-America Regional Council" style="height:56px;display:block;margin-bottom:14px">
  <h1>Stranded zones report</h1>
  <div class="sub">${esc(scenario)} · closure depth ${thresholdFt ?? '—'} ft · ${esc(areaLabel)} · generated ${esc(now)}</div>
  ${big(n0(st.closed.n), 'road segments close', `${n0(st.closed.noDetour)} of them lose every alternative route. Where a detour exists it averages ${mi(st.closed.avg)} mi, the longest ${mi(st.closed.max)} mi.`)}
  ${big(n0(st.stranded.n), st.stranded.n === 1 ? 'zone is cut off' : 'zones are cut off', `No way in or out: about ${n0(st.stranded.population)} residents, ${n0(st.stranded.jobs)} jobs, ${n0(st.stranded.facilities)} critical facilities and ${n0(st.stranded.miles)} road miles.`)}
  ${big(n0(st.single.n), st.single.n === 1 ? 'zone keeps one way out' : 'zones keep one way out', `Still reachable, but by a single surviving road; about ${n0(st.single.population)} residents.`)}
  ${mapDataUrl ? `<img class="map" src="${mapDataUrl}" alt="Map of the scenario">` : ''}
  <h2>Largest cut-off zones by population</h2>
  <table><thead><tr><th>${al('zone_id')}</th><th>${al('zone_type')}</th><th class="num">${al('population')}</th><th class="num">${al('jobs')}</th><th class="num">${al('facilities')}</th><th class="num">${al('miles')}</th><th class="num">${al('elderly_share')}</th><th class="num">${al('mobility_disab_share')}</th></tr></thead><tbody>${topRows}</tbody></table>
  <div class="foot">Population and jobs are 2020 tract totals allocated to road miles; treat them as order of magnitude. Bridges are assumed to stay open. Method: see the Methodology dialog in the Explorer (docs/methodology.md). ${esc(ATTRIBUTION)}</div>
</body></html>`
  const win = window.open('', '_blank')
  if (!win) return
  win.document.write(html)
  win.document.close()
}
