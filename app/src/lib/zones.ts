import type Geometry from '@arcgis/core/geometry/Geometry'
import type Graphic from '@arcgis/core/Graphic'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer'
import type { CatalogEntry } from '../map/controller'
import { SCENARIO_STORY as S, ZONE_FIELDS } from '../config/registry'

export interface Zone {
  id: number
  type: string
  population: number
  jobs: number
  miles: number
  facilities: number
  geometry: Geometry | null
  graphic: Graphic
}
export interface Story {
  stranded: { n: number; population: number; jobs: number; miles: number; facilities: number }
  single: { n: number; population: number }
  closed: { n: number; noDetour: number; avg: number | null; max: number | null }
  top: Zone[]
}

export const n0 = (v: unknown) => Math.round(Number(v) || 0).toLocaleString()
export const mi = (v: number | null) => (v === null ? '—' : v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString())
export const stat = (field: string, type: string, name: string) => ({ onStatisticField: field, statisticType: type, outStatisticFieldName: name })

// Explicit, not the layer's definitionExpression: sibling scenario layers are read whether drawn or not.
const thrWhere = (threshold: number | null) => (threshold === null ? '1=1' : `${S.thresholdField} = ${threshold}`)

// Option ids differ per row, so the scenario is matched across rows by label.
export function scenarioLayers(layers: CatalogEntry[], scenarioLabel: string | null): { zones: FeatureLayer | null; closed: FeatureLayer | null } {
  if (!scenarioLabel) return { zones: null, closed: null }
  const rows = layers.filter((l) => l.section === S.section)
  const pick = (title: RegExp): FeatureLayer | null => {
    const row = rows.find((l) => title.test(l.title))
    if (!row) return null
    return row.symbologies.find((s) => s.label === scenarioLabel)?.layer ?? row.layer
  }
  return { zones: pick(S.zones.title), closed: pick(S.closed.title) }
}

export async function readStory(zones: FeatureLayer | null, closed: FeatureLayer | null, area: Geometry | null, threshold: number | null): Promise<Story> {
  const spatial = area ? { geometry: area, spatialRelationship: 'intersects' } : {}
  const thr = thrWhere(threshold)
  const z = S.zones
  const empty = { n: 0, population: 0, jobs: 0, miles: 0, facilities: 0 }
  const story: Story = { stranded: { ...empty }, single: { n: 0, population: 0 }, closed: { n: 0, noDetour: 0, avg: null, max: null }, top: [] }
  if (zones) {
    const byType = await zones.queryFeatures({
      ...spatial, where: thr, returnGeometry: false, groupByFieldsForStatistics: [z.type],
      outStatistics: [stat(z.id, 'count', 'n'), stat(z.population, 'sum', 'pop'), stat(z.jobs, 'sum', 'jobs'),
        stat(z.miles, 'sum', 'mi'), stat(z.facilities, 'sum', 'fac')],
    } as any)
    for (const f of byType.features) {
      const a = f.attributes
      const row = { n: a.n, population: a.pop, jobs: a.jobs, miles: a.mi, facilities: a.fac }
      if (a[z.type] === 'stranded') story.stranded = row
      else story.single = row
    }
    const top = await zones.queryFeatures({
      ...spatial, where: thr, orderByFields: [`${z.population} DESC`], num: 25, returnGeometry: true,
      outFields: ZONE_FIELDS,
    } as any)
    story.top = top.features.map((f) => ({
      id: f.attributes[z.id], type: f.attributes[z.type], population: f.attributes[z.population] ?? 0,
      jobs: f.attributes[z.jobs] ?? 0, miles: f.attributes[z.miles] ?? 0, facilities: f.attributes[z.facilities] ?? 0,
      geometry: (f.geometry as Geometry | null) ?? null, graphic: f,
    }))
  }
  if (closed) {
    const c = S.closed
    const r = await closed.queryFeatures({
      ...spatial, where: thr, returnGeometry: false,
      outStatistics: [stat(c.id, 'count', 'n'), stat(c.noDetour, 'sum', 'nd'), stat(c.detour, 'avg', 'avg'), stat(c.detour, 'max', 'mx')],
    } as any)
    const a = r.features[0]?.attributes ?? {}
    story.closed = { n: a.n ?? 0, noDetour: a.nd ?? 0, avg: a.avg ?? null, max: a.mx ?? null }
  }
  return story
}

export async function readZonesCsvRows(zones: FeatureLayer, area: Geometry | null, threshold: number | null): Promise<Record<string, unknown>[]> {
  const spatial = area ? { geometry: area, spatialRelationship: 'intersects' } : {}
  const out: Record<string, unknown>[] = []
  for (let start = 0; ; start += 2000) {
    const r = await zones.queryFeatures({
      ...spatial, where: thrWhere(threshold), outFields: ZONE_FIELDS, returnGeometry: false,
      orderByFields: [`${S.zones.population} DESC`], start, num: 2000,
    } as any)
    for (const f of r.features) out.push(f.attributes)
    if (!r.exceededTransferLimit || !r.features.length) return out
  }
}
