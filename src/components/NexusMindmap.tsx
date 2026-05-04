import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { ForceLink, ForceNode } from '../lib/nexusPoc'

const GOLD = '#e7c547'
const PLACE_BLUE = '#38bdf8'
const EVENT_RED = '#f97373'

function kindColor(kind: ForceNode['kind']): string {
  switch (kind) {
    case 'person':
      return GOLD
    case 'place':
      return PLACE_BLUE
    case 'event':
      return EVENT_RED
    default:
      return '#94a3b8'
  }
}

type NexusMindmapProps = {
  data: { nodes: ForceNode[]; links: ForceLink[] }
  highlightId: string | null
  onHighlightChange: (id: string | null) => void
}

export function NexusMindmap({ data, highlightId, onHighlightChange }: NexusMindmapProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined)
  const [dims, setDims] = useState({ w: 400, h: 400 })
  const [pulseKey, setPulseKey] = useState(0)

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

  const graphData = useMemo(() => ({ nodes: [...data.nodes], links: [...data.links] }), [data])

  useEffect(() => {
    const t = window.setTimeout(() => fgRef.current?.zoomToFit(400, 24), 80)
    return () => window.clearTimeout(t)
  }, [graphData.nodes.length, graphData.links.length])

  const nodeCanvasObject = useCallback(
    (node: Record<string, unknown>, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const nx = node as ForceNode & { x?: number; y?: number }
      const id = String(nx.id ?? '')
      const x = nx.x ?? 0
      const y = nx.y ?? 0
      const kind = nx.kind ?? 'person'
      const hi = highlightId === id
      const rPx = (hi ? 9 : 7) / globalScale
      const c = kindColor(kind as ForceNode['kind'])

      ctx.save()
      ctx.shadowBlur = (hi ? 28 : 16) / globalScale
      ctx.shadowColor = c
      ctx.beginPath()
      ctx.arc(x, y, rPx, 0, 2 * Math.PI, false)
      ctx.fillStyle = hi ? '#fefce8' : c
      ctx.globalAlpha = hi ? 1 : 0.92
      ctx.fill()

      ctx.lineWidth = (hi ? 1.6 : 1) / globalScale
      ctx.strokeStyle = 'rgba(255,255,255,0.42)'
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.restore()

      const g = Math.max(globalScale, 0.12)
      if (globalScale > 0.28) {
        const label = String(nx.name ?? id)
        const fontPx = (hi ? 7.5 : 6.5) / g
        ctx.font = `${fontPx}px var(--font-nexus-ui, ui-sans-serif)`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const pad = rPx + 4 / g
        ctx.shadowBlur = 4 / g
        ctx.shadowColor = '#000'
        ctx.fillStyle = 'rgba(250,245,230,0.92)'
        ctx.fillText(label, x, y + pad)
        ctx.shadowBlur = 0
      }
    },
    [highlightId],
  )

  const linkCanvasObject = useCallback(
    (link: Record<string, unknown>, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const pulse = Math.sin(pulseKey * 0.31) * 0.5 + 0.5
      const ln = link as ForceLink & { source?: { x?: number; y?: number }; target?: { x?: number; y?: number } }
      const s = ln.source
      const t = ln.target
      if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) return

      const sx = s.x
      const sy = s.y
      const tx = t.x
      const ty = t.y
      const wGlow = ((4 + pulse * 2.5) / globalScale)
      const wCore = Math.max(0.7, (1 + pulse * 0.35) / globalScale)

      ctx.save()
      ctx.lineCap = 'round'
      ctx.strokeStyle = 'rgba(124,58,237,0.05)'
      ctx.lineWidth = wGlow * 2.2
      ctx.shadowBlur = (22 + pulse * 10) / globalScale
      ctx.shadowColor = 'rgba(167,139,250,0.55)'
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(tx, ty)
      ctx.stroke()

      ctx.strokeStyle = 'rgba(167,139,250,0.22)'
      ctx.lineWidth = wGlow
      ctx.shadowBlur = 10 / globalScale
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

      const mx = (sx + tx) / 2
      const my = (sy + ty) / 2
      const label = String(ln.label ?? '')
      const lg = Math.max(globalScale, 0.14)
      if (label && globalScale > 0.38) {
        ctx.save()
        ctx.font = `${6 / lg}px var(--font-nexus-mono, ui-monospace)`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const padX = 3 / lg
        const tw = ctx.measureText(label).width + padX * 2
        const th = 10 / lg
        ctx.fillStyle = 'rgba(12,10,9,0.78)'
        ctx.strokeStyle = 'rgba(139,92,246,0.35)'
        ctx.lineWidth = 1 / lg
        ctx.beginPath()
        const rx = 1.5 / lg
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
      <header className="pointer-events-none absolute left-4 top-3 z-10">
        <div className="font-[family-name:var(--font-nexus-serif)] text-xs font-semibold tracking-wide text-stone-200">
          Mindmap threads
        </div>
        <div className="mt-0.5 font-[family-name:var(--font-nexus-mono)] text-[8px] uppercase tracking-[0.14em] text-violet-300/65">
          Force layout · dossier linkage
        </div>
      </header>

      <ForceGraph2D
        ref={fgRef}
        width={dims.w}
        height={dims.h}
        graphData={graphData}
        backgroundColor="#09080b"
        nodeCanvasObjectMode={() => 'replace'}
        nodeCanvasObject={nodeCanvasObject}
        nodePointerAreaPaint={(node, color, ctx, globalScale) => {
          const n = node as ForceNode & { x?: number; y?: number }
          if (n.x == null || n.y == null) return
          const r = 14 / globalScale
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
        cooldownTicks={120}
        d3VelocityDecay={0.28}
        onNodeHover={(node) => onHighlightChange(node ? String(node.id ?? '') : null)}
      />
    </div>
  )
}
