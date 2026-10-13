/**
 * Cached statistics queries with an explicit "Reading…" state and a failure
 * message — never fabricate a range (handoff: Interactions §Statistics).
 *
 * A tiny external store: caches key → result, notifies subscribers when a
 * pending query resolves so hooks re-render.
 */

import { useSyncExternalStore } from 'react'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer'
import type Field from '@arcgis/core/layers/support/Field'

export interface NumericStats {
  pending?: boolean
  failed?: boolean
  min?: number
  max?: number
  avg?: number
}

export interface CategoryStats {
  pending?: boolean
  failed?: boolean
  rows?: { code: unknown; count: number }[]
}

const numCache = new Map<string, NumericStats>()
const catCache = new Map<string, CategoryStats>()
let version = 0
const subs = new Set<() => void>()

function bump() {
  version++
  subs.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

/** Subscribe a component to the stats cache. Returns a version number that
 *  changes whenever any pending query resolves; call it in any component that
 *  reads `numericStats`/`categoryStats` so the "Reading…" state re-renders into
 *  a real value. */
export function useStatsVersion(): number {
  return useSyncExternalStore(subscribe, () => version)
}

/** Key on the service endpoint, not the layer id: the children of a symbology
 *  group are duplicates of one service layer, so they share statistics and
 *  should share one round trip. */
function layerKey(layer: FeatureLayer): string {
  return layer.url ? `${layer.url}/${(layer as { layerId?: unknown }).layerId ?? ''}` : (layer.id ?? layer.title ?? '?')
}

/** Min/max/avg for one numeric field, cached per service endpoint + field.
 *
 *  Returns SYNCHRONOUSLY and always: `{pending:true}` on the first call (the
 *  query is fired off), the values on later calls, or `{failed:true}` if the
 *  service refused. Callers render the three states; nobody invents a range. */
export function numericStats(layer: FeatureLayer, field: Field): NumericStats {
  const key = `${layerKey(layer)}|num|${field.name}`
  const hit = numCache.get(key)
  if (hit) return hit
  const pending: NumericStats = { pending: true }
  numCache.set(key, pending)
  layer
    .queryFeatures({
      where: '1=1',
      returnGeometry: false,
      outStatistics: [
        { onStatisticField: field.name, outStatisticFieldName: 'mn', statisticType: 'min' },
        { onStatisticField: field.name, outStatisticFieldName: 'mx', statisticType: 'max' },
        { onStatisticField: field.name, outStatisticFieldName: 'av', statisticType: 'avg' },
      ],
    } as any)
    .then((res) => {
      const a = res.features[0]?.attributes ?? {}
      numCache.set(key, { min: a.mn, max: a.mx, avg: a.av })
      bump()
    })
    .catch(() => {
      numCache.set(key, { failed: true })
      bump()
    })
  return pending
}

/** Value counts for one categorical field, ordered most-common first. Same
 *  cache-and-three-states contract as `numericStats`. */
export function categoryStats(layer: FeatureLayer, field: Field): CategoryStats {
  const key = `${layerKey(layer)}|cat|${field.name}`
  const hit = catCache.get(key)
  if (hit) return hit
  const pending: CategoryStats = { pending: true }
  catCache.set(key, pending)
  layer
    .queryFeatures({
      where: '1=1',
      returnGeometry: false,
      groupByFieldsForStatistics: [field.name],
      outStatistics: [{ onStatisticField: field.name, outStatisticFieldName: 'cnt', statisticType: 'count' }],
      orderByFields: ['cnt DESC'],
    } as any)
    .then((res) => {
      catCache.set(key, {
        rows: res.features.map((fe) => ({ code: fe.attributes[field.name], count: fe.attributes.cnt })),
      })
      bump()
    })
    .catch(() => {
      catCache.set(key, { failed: true })
      bump()
    })
  return pending
}
