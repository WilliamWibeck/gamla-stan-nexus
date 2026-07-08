import { forceCollide } from 'd3-force-3d'
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import { ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { categoryColor } from '../lib/nexusCategories'
import type { ForceLink, ForceNode } from '../lib/nexusPoc'

const GOLD = '#e7c547'

function nodeColor(node: Pick<ForceNode, 'kind' | 'category'>): string {
  // People keep the warm gold accent in the graph so social threads stand out;
  // events and places use their shared category colors.
  if (node.kind === 'person') return GOLD
  return categoryColor(node.category)
}

/**
 * All sizes live in graph-space units (not divided by zoom), so the collision
 * force can reserve exactly the room each node + label needs: what the physics
 * separates is what gets drawn, and nodes/labels cannot overlap once settled.
 */
type SizedNode = ForceNode & {
  x?: number
  y?: number
  __r: number
  __font: number
  __label: string
  __collideR: number
}

const MAX_LABEL_CHARS = 22
const LABEL_GAP = 2.5
/** Approximate glyph width as a fraction of font size (sans-serif average). */
const GLYPH_W = 0.58

function truncateLabel(name: string): string {
  const text = name.trim()
  if (text.length <= MAX_LABEL_CHARS) return text
  return `${text.slice(0, MAX_LABEL_CHARS - 1)}…`
}

/** Base node radius shrinks as the graph gets busier, so big years stay readable. */
function baseRadiusFor(count: number): number {
  if (count <= 30) return 8
  if (count <= 80) return 6.5
  if (count <= 150) return 5.5
  return 4.5
}

type NexusMindmapProps = {
  data: { nodes: ForceNode[]; links: ForceLink[] }
  highlightId: string | null
  onHighlightChange: (id: string | null) => void
  /** Open a node: jump the year for ghosts, then show its map popup. */
  onNodeOpen?: (node: ForceNode) => void
  onCollapse?: () => void
}

export function NexusMindmap({ data, highlightId, onHighlightChange, onNodeOpen, onCollapse }: NexusMindmapProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined)
  const [dims, setDims] = useState({ w: 400, h: 400 })
  const [pulseKey, setPulseKey] = useState(0)
  /** Screen-space rects of labels drawn this frame, for overlap culling. */
  const labelRectsRef = useRef<{ x: number; y: number; w: number; h: number }[]>([])

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const read = () => {
      const r = el.getBoundingClientRect()
      setDims({
        w: Math.max(200, Math.floor(r.width)),
        h: Math.max(200, Math.floor(r.height)),
      })
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => setPulseKey((k) => k + 1), 420)
    return () => clearInterval(id)
  }, [])

  const graphData = useMemo(() => {
    const count = data.nodes.length
    const base = baseRadiusFor(count)
    const font = Math.max(3.4, base * 0.85)

    const degree = new Map<string, number>()
    for (const l of data.links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
    }

    const nodes: SizedNode[] = data.nodes.map((n) => {
      const deg = degree.get(n.id) ?? 0
      const r = base * (1 + Math.min(deg, 6) * 0.12)
      const label = truncateLabel(n.name)
      const labelW = label.length * font * GLYPH_W
      // Circle must cover the label hanging below the node (vertically) and
      // its width (horizontally) so the collision force keeps text apart too.
      const collideR = Math.max(r + LABEL_GAP + font + 1.5, labelW / 2 + 2)
      return { ...n, __r: r, __font: font, __label: label, __collideR: collideR }
    })

    return { nodes, links: data.links.map((l) => ({ ...l })) }
  }, [data])

  // Scale the physics with graph size: busier graphs need more repulsion and
  // room, and the collision force reserves each node's node+label footprint.
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const count = graphData.nodes.length || 1

    const charge = fg.d3Force('charge') as { strength?: (s: number) => void } | undefined
    charge?.strength?.(-(40 + count * 1.6))

    const link = fg.d3Force('link') as { distance?: (d: number) => void } | undefined
    link?.distance?.(45 + Math.min(count, 160) * 0.25)

    fg.d3Force(
      'collide',
      forceCollide((node: unknown) => (node as SizedNode).__collideR ?? 12).iterations(2),
    )
    fg.d3ReheatSimulation()
  }, [graphData])

  useEffect(() => {
    const t = window.setTimeout(() => fgRef.current?.zoomToFit(400, 24), 600)
    return () => window.clearTimeout(t)
  }, [graphData.nodes.length, graphData.links.length])

  const nodeCanvasObject = useCallback(
    (node: Record<string, unknown>, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const nx = node as SizedNode
      const id = String(nx.id ?? '')
      const x = nx.x ?? 0
      const y = nx.y ?? 0
      const hi = highlightId === id
      const ghost = nx.ghost && !hi
      const r = (nx.__r ?? 6) * (hi ? 1.25 : 1)
      const c = nodeColor(nx)

      ctx.save()
      ctx.shadowBlur = hi ? 22 : ghost ? 0 : 12
      ctx.shadowColor = c
      ctx.beginPath()
      ctx.arc(x, y, r, 0, 2 * Math.PI, false)
      ctx.fillStyle = hi ? '#fefce8' : c
      ctx.globalAlpha = hi ? 1 : ghost ? 0.3 : 0.92
      ctx.fill()

      ctx.lineWidth = hi ? 1.4 : 0.9
      ctx.strokeStyle = ghost ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.42)'
      ctx.stroke()

      // Ghosts wear their year as a badge: they belong to another point in time.
      if (ghost && nx.yearStart) {
        ctx.globalAlpha = 0.55
        ctx.font = `${Math.max(2.8, (nx.__font ?? 5) * 0.7)}px var(--font-nexus-mono, ui-monospace)`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#e7e5e4'
        ctx.fillText(String(nx.yearStart), x, y)
      }
      ctx.globalAlpha = 1
      ctx.restore()

      const font = nx.__font ?? 5
      // Skip labels that would render smaller than ~2.5 device px: unreadable smudge.
      if (!hi && font * globalScale < 2.5) return

      const label = nx.__label ?? String(nx.name ?? id)
      ctx.font = `${font}px var(--font-nexus-ui, ui-sans-serif)`
      const w = ctx.measureText(label).width
      const rect = { x: x - w / 2, y: y + r + LABEL_GAP, w, h: font }

      // Greedy overlap culling as a safety net while the simulation is still
      // settling; the highlighted node's label always wins.
      if (!hi) {
        for (const other of labelRectsRef.current) {
          if (
            rect.x < other.x + other.w &&
            rect.x + rect.w > other.x &&
            rect.y < other.y + other.h &&
            rect.y + rect.h > other.y
          ) {
            return
          }
        }
      }
      labelRectsRef.current.push(rect)

      ctx.save()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.shadowBlur = 3
      ctx.shadowColor = '#000'
      ctx.fillStyle = hi
        ? 'rgba(254,252,232,0.98)'
        : ghost
          ? 'rgba(250,245,230,0.35)'
          : 'rgba(250,245,230,0.92)'
      ctx.fillText(label, x, rect.y)
      ctx.restore()
    },
    [highlightId],
  )

  const linkCanvasObject = useCallback(
    (link: Record<string, unknown>, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const pulse = Math.sin(pulseKey * 0.31) * 0.5 + 0.5
      const ln = link as ForceLink & {
        source?: { x?: number; y?: number; ghost?: boolean }
        target?: { x?: number; y?: number; ghost?: boolean }
      }
      const s = ln.source
      const t = ln.target
      if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) return

      const sx = s.x
      const sy = s.y
      const tx = t.x
      const ty = t.y
      const wGlow = 4 + pulse * 2.5
      const wCore = 1 + pulse * 0.35
      const toGhost = Boolean(s.ghost || t.ghost)

      ctx.save()
      if (toGhost) ctx.globalAlpha = 0.3
      ctx.lineCap = 'round'
      ctx.strokeStyle = 'rgba(124,58,237,0.05)'
      ctx.lineWidth = wGlow * 2.2
      ctx.shadowBlur = 22 + pulse * 10
      ctx.shadowColor = 'rgba(167,139,250,0.55)'
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(tx, ty)
      ctx.stroke()

      ctx.strokeStyle = 'rgba(167,139,250,0.22)'
      ctx.lineWidth = wGlow
      ctx.shadowBlur = 10
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(tx, ty)
      ctx.stroke()

      ctx.shadowBlur = 0
      ctx.strokeStyle = 'rgba(237,233,254,0.88)'
      ctx.lineWidth = wCore
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(tx, ty)
      ctx.stroke()
      ctx.restore()

      const label = String(ln.label ?? '')
      // Link labels only appear once zoomed in enough to read them.
      if (label && globalScale > 0.9) {
        const mx = (sx + tx) / 2
        const my = (sy + ty) / 2
        const fontPx = 4.5
        ctx.save()
        ctx.font = `${fontPx}px var(--font-nexus-mono, ui-monospace)`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const padX = 2.5
        const tw = ctx.measureText(label).width + padX * 2
        const th = fontPx + 4
        ctx.fillStyle = 'rgba(12,10,9,0.78)'
        ctx.strokeStyle = 'rgba(139,92,246,0.35)'
        ctx.lineWidth = 0.7
        ctx.beginPath()
        const rx = 1.5
        const bx = mx - tw / 2
        const by = my - th / 2
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(bx, by, tw, th, rx)
        } else {
          ctx.rect(bx, by, tw, th)
        }
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = 'rgba(221,214,254,0.95)'
        ctx.fillText(label, mx, my)
        ctx.restore()
      }
    },
    [pulseKey],
  )

  return (
    <div ref={wrapRef} className="relative h-full min-h-0 w-full min-w-0 bg-[#09080b]">
      <header className="pointer-events-none absolute left-4 top-3 z-10 flex items-start justify-between gap-3 pr-3">
        <div>
          <div className="font-[family-name:var(--font-nexus-serif)] text-xs font-semibold tracking-wide text-stone-200">
            Mindmap threads
          </div>
          <div className="mt-0.5 font-[family-name:var(--font-nexus-mono)] text-[8px] uppercase tracking-[0.14em] text-violet-300/65">
            Force layout · dossier linkage
          </div>
          <div className="mt-0.5 font-[family-name:var(--font-nexus-mono)] text-[8px] uppercase tracking-[0.14em] text-stone-600">
            Click a node to open it · faded nodes jump to their year
          </div>
        </div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title="Collapse mindmap"
            className="pointer-events-auto rounded border border-stone-700/70 bg-stone-950/80 p-1.5 text-stone-400 transition-colors hover:border-stone-600 hover:text-stone-100"
          >
            <ChevronRight className="size-3.5" aria-hidden />
          </button>
        )}
      </header>

      <ForceGraph2D
        ref={fgRef}
        width={dims.w}
        height={dims.h}
        graphData={graphData}
        backgroundColor="#09080b"
        onRenderFramePre={() => {
          labelRectsRef.current = []
        }}
        nodeCanvasObjectMode={() => 'replace'}
        nodeCanvasObject={nodeCanvasObject}
        nodePointerAreaPaint={(node, color, ctx) => {
          const n = node as SizedNode
          if (n.x == null || n.y == null) return
          const r = (n.__r ?? 6) + 4
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(n.x, n.y, r, 0, 2 * Math.PI, false)
          ctx.fill()
        }}
        linkCanvasObjectMode={() => 'replace'}
        linkCanvasObject={linkCanvasObject}
        linkPointerAreaPaint={(link, color, ctx, globalScale) => {
          const ln = link as { source?: { x?: number; y?: number }; target?: { x?: number; y?: number } }
          const { source: s, target: t } = ln
          if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) return
          ctx.strokeStyle = color
          ctx.lineWidth = Math.max(4, 14 / globalScale)
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(s.x, s.y)
          ctx.lineTo(t.x, t.y)
          ctx.stroke()
        }}
        cooldownTicks={160}
        d3VelocityDecay={0.28}
        onEngineStop={() => fgRef.current?.zoomToFit(400, 30)}
        onNodeHover={(node) => onHighlightChange(node ? String(node.id ?? '') : null)}
        onNodeClick={(node) => onNodeOpen?.(node as ForceNode)}
      />
    </div>
  )
}
