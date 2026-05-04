import type { NexusGraph, NexusNode, NexusNodeType } from './nexusHistoricalGraph'

export type PocKind = 'person' | 'place' | 'event'

export type PocNode = {
  id: string
  name: string
  kind: PocKind
  lat: number | null
  lng: number | null
  yearStart: number
  yearEnd: number
  themes: string[]
  markerType?: NexusNodeType
}

export type PocLink = {
  source: string
  target: string
  label: string
  themes?: string[]
}

export type PocDataset = {
  meta: { yearMin: number; yearMax: number; filterThemes: string[] }
  nodes: PocNode[]
  links: PocLink[]
}

export function nodeActiveInYear(n: PocNode, year: number): boolean {
  return n.yearStart <= year && year <= n.yearEnd
}

export function nodeMatchesThemes(n: PocNode, activeThemes: Set<string>): boolean {
  if (activeThemes.size === 0) return true
  return n.themes.some((t) => activeThemes.has(t))
}

export function filterPocDataset(
  dataset: PocDataset,
  year: number,
  activeThemes: Set<string>,
): PocDataset {
  const nodes = dataset.nodes.filter(
    (n) => nodeActiveInYear(n, year) && nodeMatchesThemes(n, activeThemes),
  )
  const ids = new Set(nodes.map((n) => n.id))
  const links = dataset.links.filter((l) => ids.has(l.source) && ids.has(l.target))
  return { meta: dataset.meta, nodes, links }
}

function pocNodeToNexus(n: PocNode): NexusNode | null {
  if (n.lat == null || n.lng == null) return null
  const type: NexusNodeType = n.markerType ?? 'residence'
  return { id: n.id, name: n.name, lat: n.lat, lng: n.lng, type }
}

/** Mapbox graph: only nodes with coordinates; links only when both ends are on the map. */
export function toMapNexusGraph(filtered: PocDataset): NexusGraph {
  const mapNodes: NexusNode[] = []
  for (const n of filtered.nodes) {
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
  if (start.lat != null && start.lng != null) return nodeId
  const seen = new Set<string>([nodeId])
  const queue: string[] = [nodeId]
  while (queue.length) {
    const id = queue.shift()!
    for (const l of filtered.links) {
      const other = l.source === id ? l.target : l.target === id ? l.source : null
      if (!other || seen.has(other)) continue
      seen.add(other)
      const n = byId.get(other)
      if (n && n.lat != null && n.lng != null) return other
      queue.push(other)
    }
  }
  return null
}

export type ForceNode = {
  id: string
  name: string
  kind: PocKind
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
    nodes: filtered.nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind })),
    links: filtered.links.map((l) => ({
      source: l.source,
      target: l.target,
      label: l.label,
    })),
  }
}
