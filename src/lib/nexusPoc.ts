import type { CategoryId } from './nexusCategories'
import type { NexusGraph, NexusNode, NexusNodeType } from './nexusHistoricalGraph'

export type PocKind = 'person' | 'place' | 'event'

export type PocNode = {
  id: string
  name: string
  kind: PocKind
  category: CategoryId
  lat: number | null
  lng: number | null
  yearStart: number
  yearEnd: number
  themes: string[]
  markerType?: NexusNodeType
  metadata?: Record<string, unknown>
  /** Outside the selected year but linked to a visible node (connections are time-independent). */
  ghost?: boolean
}

export type PocLink = {
  source: string
  target: string
  label: string
  themes?: string[]
}

export type PocDataset = {
  meta: {
    yearMin: number
    yearMax: number
    /** Total node count per category (unfiltered), for sidebar badges. */
    categoryCounts: Partial<Record<CategoryId, number>>
    /** Event count per year (unfiltered), for the time-bar density strip. */
    yearCounts: Record<number, number>
  }
  nodes: PocNode[]
  links: PocLink[]
}

export const EMPTY_DATASET: PocDataset = {
  meta: { yearMin: 1750, yearMax: 1850, categoryCounts: {}, yearCounts: {} },
  nodes: [],
  links: [],
}

export function nodeActiveInYear(n: PocNode, year: number): boolean {
  return n.yearStart <= year && year <= n.yearEnd
}

export function nodeMatchesCategories(n: PocNode, active: Set<CategoryId>): boolean {
  if (active.size === 0) return true
  return active.has(n.category)
}

export function filterPocDataset(
  dataset: PocDataset,
  year: number,
  activeCategories: Set<CategoryId>,
): PocDataset {
  // People and places are time-independent anchors; only events are year-bound.
  const visible = dataset.nodes.filter(
    (n) =>
      nodeMatchesCategories(n, activeCategories) &&
      (n.kind !== 'event' || nodeActiveInYear(n, year)),
  )
  const ids = new Set(visible.map((n) => n.id))

  // Connections are time-independent: events from other years that link to a
  // visible node come along as "ghosts" so e.g. a person keeps their whole
  // recorded network in the graph. Ghosts stay off the map and ledger.
  const byId = new Map(dataset.nodes.map((n) => [n.id, n]))
  const ghostIds = new Set<string>()
  for (const l of dataset.links) {
    for (const [a, b] of [
      [l.source, l.target],
      [l.target, l.source],
    ]) {
      if (!ids.has(a) || ids.has(b) || ghostIds.has(b)) continue
      const other = byId.get(b)
      if (other && nodeMatchesCategories(other, activeCategories)) ghostIds.add(b)
    }
  }

  const nodes: PocNode[] = [
    ...visible.map((n) => ({ ...n, ghost: false })),
    ...[...ghostIds].map((id) => ({ ...byId.get(id)!, ghost: true })),
  ]
  const allIds = new Set(nodes.map((n) => n.id))
  const links = dataset.links.filter((l) => allIds.has(l.source) && allIds.has(l.target))
  return { meta: dataset.meta, nodes, links }
}

function pocNodeToNexus(n: PocNode): NexusNode | null {
  if (n.lat == null || n.lng == null) return null
  const type: NexusNodeType = n.markerType ?? 'residence'
  return {
    id: n.id,
    name: n.name,
    lat: n.lat,
    lng: n.lng,
    type,
    kind: n.kind,
    category: n.category,
    themes: n.themes,
    yearStart: n.yearStart,
    yearEnd: n.yearEnd,
    metadata: n.metadata,
  }
}

/** Mapbox graph: only nodes with coordinates; links only when both ends are on the map. */
export function toMapNexusGraph(filtered: PocDataset): NexusGraph {
  const mapNodes: NexusNode[] = []
  for (const n of filtered.nodes) {
    if (n.ghost) continue // the map stays year-accurate
    const nx = pocNodeToNexus(n)
    if (nx) mapNodes.push(nx)
  }
  const onMap = new Set(mapNodes.map((m) => m.id))
  const links = filtered.links
    .filter((l) => onMap.has(l.source) && onMap.has(l.target))
    .map((l) => ({ source: l.source, target: l.target, label: l.label }))
  return { nodes: mapNodes, links }
}

/** Target marker id to emphasize when a graph node (person/place) is selected. */
export function mapHighlightTargetId(
  highlightId: string | null,
  filtered: PocDataset,
): string | null {
  if (!highlightId) return null
  const byId = new Map(filtered.nodes.map((n) => [n.id, n]))
  const n = byId.get(highlightId)
  if (n && n.lat != null && n.lng != null) return highlightId
  return resolveMapPeerId(highlightId, filtered)
}

/** First map-marked neighbor for graph-only nodes (e.g. people). */
export function resolveMapPeerId(
  nodeId: string,
  filtered: PocDataset,
): string | null {
  const byId = new Map(filtered.nodes.map((n) => [n.id, n]))
  const start = byId.get(nodeId)
  if (!start) return null
  if (!start.ghost && start.lat != null && start.lng != null) return nodeId
  const seen = new Set<string>([nodeId])
  const queue: string[] = [nodeId]
  while (queue.length) {
    const id = queue.shift()!
    for (const l of filtered.links) {
      const other = l.source === id ? l.target : l.target === id ? l.source : null
      if (!other || seen.has(other)) continue
      seen.add(other)
      const n = byId.get(other)
      // Ghosts aren't on the map, so they can't be highlight targets.
      if (n && !n.ghost && n.lat != null && n.lng != null) return other
      queue.push(other)
    }
  }
  return null
}

export type ForceNode = {
  id: string
  name: string
  kind: PocKind
  category: CategoryId
  ghost: boolean
  yearStart: number
}

export type ForceLink = {
  source: string
  target: string
  label: string
}

export function toForceGraphData(filtered: PocDataset): {
  nodes: ForceNode[]
  links: ForceLink[]
} {
  return {
    nodes: filtered.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      category: n.category,
      ghost: n.ghost ?? false,
      yearStart: n.yearStart,
    })),
    links: filtered.links.map((l) => ({
      source: l.source,
      target: l.target,
      label: l.label,
    })),
  }
}
