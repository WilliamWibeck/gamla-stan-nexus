import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { NexusMindmap } from './components/NexusMindmap'
import { NexusSidebar } from './components/NexusSidebar'
import { NexusMap, type FocusRequest } from './components/NexusMap'
import { NexusTimeBar } from './components/NexusTimeBar'
import { NexusEventLedger } from './components/NexusEventLedger'
import { categorizeNode, type CategoryId } from './lib/nexusCategories'
import {
  EMPTY_DATASET,
  filterPocDataset,
  mapHighlightTargetId,
  type PocLink,
  type PocDataset,
  type PocNode,
  toForceGraphData,
  toMapNexusGraph,
} from './lib/nexusPoc'

type MasterNode = {
  id: string
  label: string
  type: 'person' | 'place' | 'event'
  lat: number | null
  lng: number | null
  metadata?: Record<string, unknown>
}

type MasterLink = {
  source: string
  target: string
  relationship: string
  strength: number
}

type MasterDataset = {
  nodes: MasterNode[]
  links: MasterLink[]
}

type LoadState = 'loading' | 'ready' | 'error'

/** Timeline window: dated records outside this range are treated as data noise. */
const YEAR_FLOOR = 1600
const YEAR_CEIL = 1900

function toPocDatasetFromMaster(master: MasterDataset): PocDataset {
  const datedYears: number[] = []

  const nodes: PocNode[] = master.nodes.map((n) => {
    const meta = n.metadata || {}
    const innerMeta = (meta.metadata as Record<string, unknown>) || {}

    let themes: string[] = []
    if (Array.isArray(meta.themes)) themes = meta.themes as string[]
    else if (Array.isArray(innerMeta.themes)) themes = innerMeta.themes as string[]
    else if (meta.theme) themes = [meta.theme as string]

    let yearStart: number | null = null
    const dateStr = (meta.date || meta.year || innerMeta.date) as string
    if (dateStr) {
      const match = String(dateStr).match(/^(\d{4})/)
      if (match) yearStart = parseInt(match[1], 10)
    }
    if (yearStart != null && yearStart >= YEAR_FLOOR && yearStart <= YEAR_CEIL) {
      datedYears.push(yearStart)
    }

    return {
      id: n.id,
      name: n.label,
      kind: n.type,
      category: categorizeNode(n.type, n.label, n.metadata),
      lat: typeof n.lat === 'number' ? n.lat : null,
      lng: typeof n.lng === 'number' ? n.lng : null,
      // Undated records span the whole window so they're always visible.
      yearStart: yearStart ?? YEAR_FLOOR,
      yearEnd: yearStart ?? YEAR_CEIL,
      themes,
      markerType: n.type === 'event' ? 'event' : 'residence',
      metadata: n.metadata,
    }
  })

  const links: PocLink[] = master.links.map((l) => ({
    source: l.source,
    target: l.target,
    label: l.relationship,
  }))

  const yearMin = datedYears.length ? Math.min(...datedYears) : 1750
  const yearMax = datedYears.length ? Math.max(...datedYears) : 1850

  const categoryCounts: Partial<Record<CategoryId, number>> = {}
  for (const n of nodes) {
    categoryCounts[n.category] = (categoryCounts[n.category] ?? 0) + 1
  }

  const yearCounts: Record<number, number> = {}
  for (const y of datedYears) {
    yearCounts[y] = (yearCounts[y] ?? 0) + 1
  }

  return {
    meta: { yearMin, yearMax, categoryCounts, yearCounts },
    nodes,
    links,
  }
}

/** How often to re-check nexus_master.json for pipeline output (ms). */
const DATA_REFRESH_MS = 20_000

function App() {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [poc, setPoc] = useState<PocDataset>(EMPTY_DATASET)
  const [year, setYear] = useState<number>(1787)
  const [activeCategories, setActiveCategories] = useState<Set<CategoryId>>(() => new Set())
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const focusTokenRef = useRef(0)
  const lastRawRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async (initial: boolean) => {
      try {
        const res = await fetch('/nexus_master.json', { cache: 'no-store' })
        if (!res.ok) throw new Error(`Failed to load nexus_master.json (${res.status})`)
        const raw = await res.text()
        if (cancelled || raw === lastRawRef.current) return
        const data = JSON.parse(raw) as MasterDataset
        if (!Array.isArray(data.nodes) || !Array.isArray(data.links)) {
          throw new Error('nexus_master.json has an invalid shape')
        }
        const dataset = toPocDatasetFromMaster(data)
        if (dataset.nodes.length === 0) throw new Error('nexus_master.json contains no nodes')
        lastRawRef.current = raw
        setPoc(dataset)
        if (initial) {
          // Land on the year with the most records so the first view isn't empty.
          const busiest = Object.entries(dataset.meta.yearCounts).sort((a, b) => b[1] - a[1])[0]
          setYear(busiest ? Number(busiest[0]) : Math.round((dataset.meta.yearMin + dataset.meta.yearMax) / 2))
        }
        setLoadState('ready')
      } catch {
        if (!cancelled && initial) setLoadState('error')
      }
    }

    void load(true)
    // Keep polling: the pipeline (run_pipeline.py --watch) rewrites the file
    // when new scans are processed, and the app picks it up without a reload.
    const id = window.setInterval(() => void load(false), DATA_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const meta = poc.meta
  const filtered = useMemo(
    () => filterPocDataset(poc, year, activeCategories),
    [poc, year, activeCategories],
  )
  const mapGraph = useMemo(() => toMapNexusGraph(filtered), [filtered])
  const mindGraph = useMemo(() => toForceGraphData(filtered), [filtered])
  const highlightMapTargetId = mapHighlightTargetId(highlightId, filtered)

  const toggleCategory = useCallback((category: CategoryId) => {
    setActiveCategories((prev) => {
      const n = new Set(prev)
      if (n.has(category)) n.delete(category)
      else n.add(category)
      return n
    })
  }, [])

  const clearCategories = useCallback(() => setActiveCategories(new Set()), [])

  const onMarkerHover = useCallback((id: string | null) => setHighlightId(id), [])

  const nodesById = useMemo(() => new Map(poc.nodes.map((n) => [n.id, n])), [poc])

  /**
   * Clicking a graph node opens it: ghosts first jump the timeline to their
   * year, then the map eases to the marker and opens its popup (the focus
   * request stays pending until the rebuilt map contains the node).
   */
  const onNodeOpen = useCallback(
    (clicked: { id: string; ghost: boolean; yearStart: number }) => {
      const node = nodesById.get(clicked.id)
      if (!node) return
      if (clicked.ghost && node.yearStart >= poc.meta.yearMin && node.yearStart <= poc.meta.yearMax) {
        setYear(node.yearStart)
      }
      setHighlightId(clicked.id)
      if (node.lat != null && node.lng != null) {
        focusTokenRef.current += 1
        setFocusRequest({ nodeId: clicked.id, token: focusTokenRef.current })
      }
    },
    [nodesById, poc.meta.yearMin, poc.meta.yearMax],
  )

  if (loadState === 'loading') {
    return (
      <div className="flex h-dvh items-center justify-center bg-[#09080b] text-stone-400">
        <p className="font-[family-name:var(--font-nexus-mono)] text-sm tracking-wide">Loading archive…</p>
      </div>
    )
  }

  if (loadState === 'error') {
    return (
      <div className="flex h-dvh items-center justify-center bg-[#09080b] px-6 text-center text-stone-300">
        <div className="max-w-md">
          <p className="font-[family-name:var(--font-nexus-serif)] text-xl text-stone-100">No data loaded</p>
          <p className="mt-3 font-[family-name:var(--font-nexus-mono)] text-xs leading-relaxed text-stone-500">
            Run <code className="text-stone-400">python tools/build_nexus_master.py</code> to build{' '}
            <code className="text-stone-400">public/nexus_master.json</code> from sources in{' '}
            <code className="text-stone-400">data_sources/</code>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-dvh min-h-dvh w-full flex-col overflow-hidden bg-[#09080b] text-stone-200">
      <div className="flex min-h-0 min-w-0 flex-1">
        <NexusSidebar
          categoryCounts={meta.categoryCounts}
          activeCategories={activeCategories}
          onToggleCategory={toggleCategory}
          onClearCategories={clearCategories}
        />

        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-3 md:grid-cols-[1.2fr_1fr_0.8fr] md:grid-rows-1">
          <div className="relative min-h-0 min-w-0 border-b border-stone-800/55 md:border-b-0 md:border-r">
            <NexusMap
              mapGraph={mapGraph}
              highlightTargetId={highlightMapTargetId}
              focusRequest={focusRequest}
              onMarkerHover={onMarkerHover}
            />
          </div>

          <div className="relative min-h-0 min-w-0 border-b border-stone-800/55 md:border-b-0 md:border-r">
            <NexusMindmap
              data={mindGraph}
              highlightId={highlightId}
              onHighlightChange={setHighlightId}
              onNodeOpen={onNodeOpen}
            />
          </div>

          <div className="relative min-h-0 min-w-0 border-stone-800/55">
            <NexusEventLedger
              nodes={filtered.nodes}
              highlightId={highlightId}
              onHighlightChange={setHighlightId}
            />
          </div>
        </div>
      </div>

      <NexusTimeBar
        year={year}
        yearMin={meta.yearMin}
        yearMax={meta.yearMax}
        yearCounts={meta.yearCounts}
        onYearChange={setYear}
      />
    </div>
  )
}

export default App
