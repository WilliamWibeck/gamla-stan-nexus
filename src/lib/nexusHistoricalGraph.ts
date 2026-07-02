import type { FeatureCollection, Feature, LineString } from 'geojson'
import mapboxgl from 'mapbox-gl'

import { categoryColor, type CategoryId } from './nexusCategories'
import { markerPopupHtml, markerPopupOptions } from './nexusMarkerPopup'

export type NexusNodeType = 'event' | 'residence' | 'security'

export type NexusNode = {
  id: string
  name: string
  lat: number
  lng: number
  type: NexusNodeType
  kind?: 'person' | 'place' | 'event'
  category?: CategoryId
  themes?: string[]
  yearStart?: number
  yearEnd?: number
  metadata?: Record<string, unknown>
}

export type NexusLink = {
  source: string
  target: string
  label: string
}

export type NexusGraph = {
  nodes: NexusNode[]
  links: NexusLink[]
}

const SOURCE_ID = 'nexus-historical-links'
const OUTER_LAYER = 'nexus-links-outer'
const FLOW_LAYER = 'nexus-links-flow'

/** Layer ids for queries (wide layer first improves hit-testing). */
export const NEXUS_LINK_HIT_LAYERS = [FLOW_LAYER, OUTER_LAYER]

export type NexusHistoricalGraphHooks = {
  onMarkerHover?: (nodeId: string | null) => void
  /** Map marker id currently linked to graph highlight / selection. */
  getMarkerHighlightId?: () => string | null
}

export function markerColor(node: Pick<NexusNode, 'type' | 'category'>): string {
  if (node.category) return categoryColor(node.category)
  switch (node.type) {
    case 'event':
      return '#f87171'
    case 'residence':
      return '#60a5fa'
    case 'security':
      return '#facc15'
    default:
      return '#94a3b8'
  }
}

function createMarkerRoot(
  node: NexusNode,
  hooks: NexusHistoricalGraphHooks | undefined,
  options?: { suppressHoverClear?: boolean },
): { wrap: HTMLElement; dot: HTMLElement } {
  const nodeId = node.id
  const wrap = document.createElement('div')
  wrap.className = 'nexus-map-marker-root'
  wrap.dataset.nexusNodeId = nodeId
  wrap.style.display = 'flex'
  wrap.style.alignItems = 'center'
  wrap.style.justifyContent = 'center'
  wrap.style.pointerEvents = 'auto'

  const dot = document.createElement('div')
  dot.className = 'nexus-map-marker-dot'
  const c = markerColor(node)
  dot.style.width = '14px'
  dot.style.height = '14px'
  dot.style.borderRadius = '50%'
  dot.style.background = `radial-gradient(circle at 30% 30%, rgba(255,255,255,0.95), ${c})`
  dot.style.boxShadow = `0 0 10px ${c}, 0 0 22px ${c}66`
  dot.style.border = '1px solid rgba(254,249,239,0.45)'
  dot.style.pointerEvents = 'auto'
  dot.style.transition =
    'box-shadow 140ms ease, transform 140ms ease, filter 140ms ease, background 140ms ease'

  wrap.appendChild(dot)

  wrap.addEventListener('mouseenter', () => hooks?.onMarkerHover?.(nodeId))
  if (!options?.suppressHoverClear) {
    wrap.addEventListener('mouseleave', () => hooks?.onMarkerHover?.(null))
  }

  return { wrap, dot }
}

function locationKey(lat: number, lng: number): string {
  return `${lng.toFixed(6)}:${lat.toFixed(6)}`
}

function groupNodesByLocation(nodes: NexusNode[]): NexusNode[][] {
  const groups = new Map<string, NexusNode[]>()
  for (const node of nodes) {
    const key = locationKey(node.lat, node.lng)
    const group = groups.get(key) ?? []
    group.push(node)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => group.sort((a, b) => a.name.localeCompare(b.name)))
}

const FAN_RADIUS_PX = 36

function stackOffset(index: number, total: number): { x: number; y: number } {
  const layer = total - 1 - index
  return { x: layer * 2, y: -layer * 3 }
}

function fanOffset(index: number, total: number): { x: number; y: number } {
  if (total <= 1) return { x: 0, y: 0 }
  const angle = (2 * Math.PI * index) / total - Math.PI / 2
  return {
    x: Math.cos(angle) * FAN_RADIUS_PX,
    y: Math.sin(angle) * FAN_RADIUS_PX,
  }
}

type ClusterController = {
  setExpanded: (expanded: boolean) => void
  containsNode: (nodeId: string) => boolean
}

function installClusterMarker(
  map: mapboxgl.Map,
  nodes: NexusNode[],
  hooks: NexusHistoricalGraphHooks | undefined,
  markerDotsById: Map<string, HTMLElement>,
  clusterControllers: ClusterController[],
): mapboxgl.Marker {
  const anchor = nodes[0]
  const total = nodes.length

  const clusterEl = document.createElement('div')
  clusterEl.className = 'nexus-marker-cluster'
  clusterEl.setAttribute('aria-label', `${total} records at this location`)

  const itemsEl = document.createElement('div')
  itemsEl.className = 'nexus-marker-cluster-items'

  const badge = document.createElement('div')
  badge.className = 'nexus-marker-cluster-badge'
  badge.textContent = String(total)
  badge.setAttribute('aria-hidden', 'true')

  const nodeIds = new Set(nodes.map((n) => n.id))

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const stack = stackOffset(i, total)
    const fan = fanOffset(i, total)
    const { wrap, dot } = createMarkerRoot(node, hooks, { suppressHoverClear: true })
    wrap.classList.add('nexus-marker-cluster-item')
    wrap.style.setProperty('--stack-x', `${stack.x}px`)
    wrap.style.setProperty('--stack-y', `${stack.y}px`)
    wrap.style.setProperty('--fan-x', `${fan.x}px`)
    wrap.style.setProperty('--fan-y', `${fan.y}px`)
    wrap.style.setProperty('--stack-i', String(i))
    markerDotsById.set(node.id, dot)

    wrap.addEventListener('click', (e) => {
      e.stopPropagation()
      new mapboxgl.Popup(markerPopupOptions())
        .setLngLat([anchor.lng, anchor.lat])
        .setHTML(markerPopupHtml(node))
        .addTo(map)
    })

    itemsEl.appendChild(wrap)
  }

  clusterEl.appendChild(itemsEl)
  clusterEl.appendChild(badge)

  const setExpanded = (next: boolean) => {
    clusterEl.classList.toggle('nexus-marker-cluster--expanded', next)
    badge.hidden = next
  }

  clusterEl.addEventListener('mouseenter', () => setExpanded(true))
  clusterEl.addEventListener('mouseleave', () => {
    setExpanded(false)
    hooks?.onMarkerHover?.(null)
  })

  clusterControllers.push({
    setExpanded,
    containsNode: (nodeId) => nodeIds.has(nodeId),
  })

  return new mapboxgl.Marker({ element: clusterEl, anchor: 'center' })
    .setLngLat([anchor.lng, anchor.lat])
    .addTo(map)
}

function installSingleMarker(
  map: mapboxgl.Map,
  node: NexusNode,
  hooks: NexusHistoricalGraphHooks | undefined,
  markerDotsById: Map<string, HTMLElement>,
): mapboxgl.Marker {
  const { wrap: el, dot } = createMarkerRoot(node, hooks)
  markerDotsById.set(node.id, dot)
  return new mapboxgl.Marker({ element: el, anchor: 'center' })
    .setLngLat([node.lng, node.lat])
    .setPopup(
      new mapboxgl.Popup(markerPopupOptions()).setHTML(markerPopupHtml(node)),
    )
    .addTo(map)
}

function buildLinksFeatureCollection(graph: NexusGraph): FeatureCollection<LineString> {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]))
  const features: Feature<LineString>[] = []
  for (const link of graph.links) {
    const a = nodesById.get(link.source)
    const b = nodesById.get(link.target)
    if (!a || !b) continue
    features.push({
      type: 'Feature',
      properties: { label: link.label },
      geometry: {
        type: 'LineString',
        coordinates: [
          [a.lng, a.lat],
          [b.lng, b.lat],
        ],
      },
    })
  }
  return { type: 'FeatureCollection', features }
}

function flowGradientExpression(phase: number): unknown {
  const lo = Math.max(0, phase - 0.08)
  const hi = Math.min(1, phase + 0.08)

  // Mapbox requires strictly ascending stop positions; lo/phase/hi can coincide near 0 or 1.
  const stopsByPos = new Map<number, string>()
  const setStop = (pos: number, color: string) => {
    stopsByPos.set(pos, color)
  }

  setStop(0, 'rgba(76, 29, 149, 0.35)')
  setStop(lo, 'rgba(139, 92, 246, 0.55)')
  setStop(phase, 'rgba(253, 244, 255, 1)')
  setStop(hi, 'rgba(147, 51, 234, 0.55)')
  setStop(1, 'rgba(46, 16, 101, 0.35)')

  const expr: unknown[] = ['interpolate', ['linear'], ['line-progress']]
  for (const [pos, color] of [...stopsByPos.entries()].sort((a, b) => a[0] - b[0])) {
    expr.push(pos, color)
  }
  return expr
}

export type NexusHistoricalGraphController = {
  dispose: () => void
  /** Ease to a node's marker and open its detail popup. Returns false if the node isn't on the map. */
  openPopup: (nodeId: string) => boolean
}

/** Markers, neon glowing lines, flowing gradient pulse. */
export function installNexusHistoricalGraph(
  map: mapboxgl.Map,
  graph: NexusGraph,
  isDisposed: () => boolean,
  hooks?: NexusHistoricalGraphHooks,
): NexusHistoricalGraphController {
  const fc = buildLinksFeatureCollection(graph)

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    lineMetrics: true,
    data: fc,
  })

  map.addLayer({
    id: OUTER_LAYER,
    type: 'line',
    source: SOURCE_ID,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#a78bfa',
      'line-width': 14,
      'line-blur': 7,
      'line-opacity': 0.5,
      'line-translate-anchor': 'map',
    },
  })

  map.addLayer({
    id: FLOW_LAYER,
    type: 'line',
    source: SOURCE_ID,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-gradient': flowGradientExpression(0) as never,
      'line-width': 4,
      'line-blur': 0.6,
      'line-opacity': 0.92,
      'line-translate-anchor': 'map',
    },
  })

  const onLineEnter = () => {
    map.getCanvas().style.cursor = 'pointer'
  }
  const onLineLeave = () => {
    map.getCanvas().style.cursor = ''
  }

  map.on('mouseenter', OUTER_LAYER, onLineEnter)
  map.on('mouseleave', OUTER_LAYER, onLineLeave)
  map.on('mouseenter', FLOW_LAYER, onLineEnter)
  map.on('mouseleave', FLOW_LAYER, onLineLeave)

  const markerDotsById = new Map<string, HTMLElement>()
  const clusterControllers: ClusterController[] = []
  const markers: mapboxgl.Marker[] = []

  for (const group of groupNodesByLocation(graph.nodes)) {
    if (group.length === 1) {
      markers.push(installSingleMarker(map, group[0], hooks, markerDotsById))
    } else {
      markers.push(installClusterMarker(map, group, hooks, markerDotsById, clusterControllers))
    }
  }

  let raf = 0

  function tick() {
    if (isDisposed()) return
    const t = performance.now()
    const pulse = (Math.sin(t / 680) + 1) / 2
    const drift = ((t % 5400) / 5400) % 1
    const hi = hooks?.getMarkerHighlightId?.() ?? null
    for (const [id, dot] of markerDotsById) {
      const hot = hi === id
      dot.classList.toggle('nexus-map-marker-dot--hot', hot)
    }
    if (hi) {
      for (const cluster of clusterControllers) {
        if (cluster.containsNode(hi)) cluster.setExpanded(true)
      }
    }
    try {
      map.setPaintProperty(OUTER_LAYER, 'line-width', 11 + pulse * 7)
      map.setPaintProperty(OUTER_LAYER, 'line-opacity', 0.38 + pulse * 0.32)
      map.setPaintProperty(OUTER_LAYER, 'line-blur', 5 + pulse * 4)
      map.setPaintProperty(FLOW_LAYER, 'line-gradient', flowGradientExpression(drift) as never)
      map.setPaintProperty(FLOW_LAYER, 'line-width', 3 + pulse * 1.2)
      map.setPaintProperty(FLOW_LAYER, 'line-opacity', 0.82 + pulse * 0.15)
    } catch {
      /* layers removed mid-frame */
    }
    raf = requestAnimationFrame(tick)
  }

  raf = requestAnimationFrame(tick)

  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]))
  let openedPopup: mapboxgl.Popup | null = null

  const openPopup = (nodeId: string): boolean => {
    if (isDisposed()) return false
    const node = nodesById.get(nodeId)
    if (!node) return false

    openedPopup?.remove()
    // Expand the cluster this node sits in so the marker is visible behind the popup.
    for (const cluster of clusterControllers) {
      cluster.setExpanded(cluster.containsNode(nodeId))
    }
    map.easeTo({ center: [node.lng, node.lat], duration: 650 })
    openedPopup = new mapboxgl.Popup(markerPopupOptions())
      .setLngLat([node.lng, node.lat])
      .setHTML(markerPopupHtml(node))
      .addTo(map)
    return true
  }

  const dispose = () => {
    cancelAnimationFrame(raf)
    openedPopup?.remove()
    openedPopup = null
    map.off('mouseenter', OUTER_LAYER, onLineEnter)
    map.off('mouseleave', OUTER_LAYER, onLineLeave)
    map.off('mouseenter', FLOW_LAYER, onLineEnter)
    map.off('mouseleave', FLOW_LAYER, onLineLeave)
    markers.forEach((m) => m.remove())
    if (map.getLayer(FLOW_LAYER)) map.removeLayer(FLOW_LAYER)
    if (map.getLayer(OUTER_LAYER)) map.removeLayer(OUTER_LAYER)
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
  }

  return { dispose, openPopup }
}
