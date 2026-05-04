import type { FeatureCollection, Feature, LineString } from 'geojson'
import mapboxgl from 'mapbox-gl'

export type NexusNodeType = 'event' | 'residence' | 'security'

export type NexusNode = {
  id: string
  name: string
  lat: number
  lng: number
  type: NexusNodeType
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

export function markerColor(type: NexusNodeType): string {
  switch (type) {
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function createMarkerRoot(
  type: NexusNodeType,
  nodeId: string,
  hooks: NexusHistoricalGraphHooks | undefined,
): { wrap: HTMLElement; dot: HTMLElement } {
  const wrap = document.createElement('div')
  wrap.className = 'nexus-map-marker-root'
  wrap.dataset.nexusNodeId = nodeId
  wrap.style.display = 'flex'
  wrap.style.alignItems = 'center'
  wrap.style.justifyContent = 'center'
  wrap.style.pointerEvents = 'auto'

  const dot = document.createElement('div')
  dot.className = 'nexus-map-marker-dot'
  const c = markerColor(type)
  dot.style.width = '14px'
  dot.style.height = '14px'
  dot.style.borderRadius = '50%'
  dot.style.background = `radial-gradient(circle at 30% 30%, rgba(255,255,255,0.95), ${c})`
  dot.style.boxShadow = `0 0 10px ${c}, 0 0 20px rgba(167,139,250,0.9)`
  dot.style.border = '1px solid rgba(254,249,239,0.45)'
  dot.style.pointerEvents = 'auto'
  dot.style.transition =
    'box-shadow 140ms ease, transform 140ms ease, filter 140ms ease, background 140ms ease'

  wrap.appendChild(dot)

  wrap.addEventListener('mouseenter', () => hooks?.onMarkerHover?.(nodeId))
  wrap.addEventListener('mouseleave', () => hooks?.onMarkerHover?.(null))

  return { wrap, dot }
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
  return [
    'interpolate',
    ['linear'],
    ['line-progress'],
    0,
    'rgba(76, 29, 149, 0.35)',
    lo,
    'rgba(139, 92, 246, 0.55)',
    phase,
    'rgba(253, 244, 255, 1)',
    hi,
    'rgba(147, 51, 234, 0.55)',
    1,
    'rgba(46, 16, 101, 0.35)',
  ]
}

/** Markers, neon glowing lines, flowing gradient pulse. */
export function installNexusHistoricalGraph(
  map: mapboxgl.Map,
  graph: NexusGraph,
  isDisposed: () => boolean,
  hooks?: NexusHistoricalGraphHooks,
): () => void {
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

  const markers = graph.nodes.map((node) => {
    const { wrap: el, dot } = createMarkerRoot(node.type, node.id, hooks)
    markerDotsById.set(node.id, dot)
    return new mapboxgl.Marker({ element: el, anchor: 'center' })
      .setLngLat([node.lng, node.lat])
      .setPopup(
        new mapboxgl.Popup({ offset: 12, closeButton: true }).setHTML(
          `<div class="nexus-graph-marker-popup rounded border border-amber-900/35 bg-stone-950/95 px-3 py-2 shadow-lg backdrop-blur-md">
             <div class="font-[family-name:var(--font-nexus-serif)] text-[13px] text-stone-100">${escapeHtml(node.name)}</div>
             <div class="mt-1 font-[family-name:var(--font-nexus-mono)] text-[10px] uppercase tracking-wider" style="color:${markerColor(node.type)}">${escapeHtml(node.type)}</div>
           </div>`,
        ),
      )
      .addTo(map)
  })

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

  return () => {
    cancelAnimationFrame(raf)
    map.off('mouseenter', OUTER_LAYER, onLineEnter)
    map.off('mouseleave', OUTER_LAYER, onLineLeave)
    map.off('mouseenter', FLOW_LAYER, onLineEnter)
    map.off('mouseleave', FLOW_LAYER, onLineLeave)
    markers.forEach((m) => m.remove())
    if (map.getLayer(FLOW_LAYER)) map.removeLayer(FLOW_LAYER)
    if (map.getLayer(OUTER_LAYER)) map.removeLayer(OUTER_LAYER)
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
  }
}
