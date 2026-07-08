import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, Network, Newspaper } from 'lucide-react'

import { NexusMindmap } from './components/NexusMindmap'
import { NexusSidebar } from './components/NexusSidebar'
import { NexusMap, type FocusRequest } from './components/NexusMap'
import { NexusTimeBar } from './components/NexusTimeBar'
import { NexusEventLedger } from './components/NexusEventLedger'
import { categorizeNode, type CategoryId } from './lib/nexusCategories'
import { monthFromIso, parseRecordDate, YEAR_CEIL, YEAR_FLOOR } from './lib/nexusDates'
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

function toPocDatasetFromMaster(master: MasterDataset): PocDataset {
  const datedYears: number[] = []
  const monthCountsByYear: Record<number, Record<number, number>> = {}

  const nodes: PocNode[] = master.nodes.map((n) => {
    const meta = n.metadata || {}
    const innerMeta = (meta.metadata as Record<string, unknown>) || {}

    let themes: string[] = []
    if (Array.isArray(meta.themes)) themes = meta.themes as string[]
    else if (Array.isArray(innerMeta.themes)) themes = innerMeta.themes as string[]
    else if (meta.theme) themes = [meta.theme as string]

    const dateStr = meta.date ?? meta.year ?? innerMeta.date ?? innerMeta.issue_date
    const parsed = parseRecordDate(dateStr)
    const yearStart = parsed?.year ?? null
    if (yearStart != null) {
      datedYears.push(yearStart)
      if (n.type === 'event' && parsed?.month != null && parsed.iso) {
        const buckets = monthCountsByYear[yearStart] ?? {}
        buckets[parsed.month] = (buckets[parsed.month] ?? 0) + 1
        monthCountsByYear[yearStart] = buckets
      }
    }

    return {
      id: n.id,
      name: n.label,
      kind: n.type,
      category: categorizeNode(n.type, n.label, n.metadata),
      lat: typeof n.lat === 'number' ? n.lat : null,
      lng: typeof n.lng === 'number' ? n.lng : null,
      yearStart: yearStart ?? YEAR_FLOOR,
      yearEnd: yearStart ?? YEAR_CEIL,
      dateStart: parsed?.iso ?? null,
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
    meta: { yearMin, yearMax, categoryCounts, yearCounts, monthCountsByYear },
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
  const [month, setMonth] = useState<number | null>(null)
  const [activeCategories, setActiveCategories] = useState<Set<CategoryId>>(() => new Set())
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const [mindmapOpen, setMindmapOpen] = useState(true)
  const [noticesOpen, setNoticesOpen] = useState(true)
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
    () => filterPocDataset(poc, year, month, activeCategories),
    [poc, year, month, activeCategories],
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
  const onYearChange = useCallback((y: number) => {
    setYear(y)
    setMonth(null)
  }, [])

  const onNodeOpen = useCallback(
    (clicked: { id: string; ghost: boolean; yearStart: number }) => {
      const node = nodesById.get(clicked.id)
      if (!node) return
      if (clicked.ghost && node.yearStart >= poc.meta.yearMin && node.yearStart <= poc.meta.yearMax) {
        setYear(node.yearStart)
        setMonth(monthFromIso(node.dateStart))
      }
      setHighlightId(clicked.id)
      if (node.lat != null && node.lng != null) {
        focusTokenRef.current += 1
        setFocusRequest({ nodeId: clicked.id, token: focusTokenRef.current })
      }
    },
    [nodesById, poc.meta.yearMin, poc.meta.yearMax],
  )

  const mainGridStyle = useMemo(() => {
    const cols: string[] = ['minmax(0,1.2fr)']
    if (mindmapOpen) cols.push('minmax(0,1fr)')
    if (noticesOpen) cols.push('minmax(0,0.85fr)')
    return { gridTemplateColumns: cols.join(' ') }
  }, [mindmapOpen, noticesOpen])

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

        <div
          className="grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[1.2fr_1fr_0.85fr] md:grid-rows-1"
          style={mainGridStyle}
        >
          <div className="relative min-h-0 min-w-0 border-b border-stone-800/55 md:border-b-0 md:border-r">
            <NexusMap
              mapGraph={mapGraph}
              highlightTargetId={highlightMapTargetId}
              focusRequest={focusRequest}
              onMarkerHover={onMarkerHover}
            />
          </div>

          {mindmapOpen ? (
            <div className="relative min-h-0 min-w-0 border-b border-stone-800/55 max-md:block md:border-b-0 md:border-r">
              <NexusMindmap
                data={mindGraph}
                highlightId={highlightId}
                onHighlightChange={setHighlightId}
                onNodeOpen={onNodeOpen}
                onCollapse={() => setMindmapOpen(false)}
              />
            </div>
          ) : (
            <>
              <div className="relative min-h-0 min-w-0 border-b border-stone-800/55 max-md:block md:hidden md:border-b-0 md:border-r">
                <NexusMindmap
                  data={mindGraph}
                  highlightId={highlightId}
                  onHighlightChange={setHighlightId}
                  onNodeOpen={onNodeOpen}
                />
              </div>
              <div className="hidden min-h-0 w-9 shrink-0 flex-col items-center border-stone-800/55 md:flex md:border-r">
              <button
                type="button"
                onClick={() => setMindmapOpen(true)}
                title="Show mindmap"
                className="flex h-full w-full flex-col items-center justify-center gap-2 border-0 bg-stone-950/40 text-stone-500 transition-colors hover:bg-stone-900/60 hover:text-violet-300"
              >
                <Network className="size-4" aria-hidden />
                <span className="font-[family-name:var(--font-nexus-mono)] text-[8px] uppercase tracking-[0.18em] [writing-mode:vertical-rl]">
                  Mindmap
                </span>
                <ChevronLeft className="size-3" aria-hidden />
              </button>
            </div>
            </>
          )}

          {noticesOpen ? (
            <div className="relative min-h-0 min-w-0 border-stone-800/55 max-md:block">
              <NexusEventLedger
                nodes={filtered.nodes}
                highlightId={highlightId}
                onHighlightChange={setHighlightId}
                onCollapse={() => setNoticesOpen(false)}
              />
            </div>
          ) : (
            <>
              <div className="relative min-h-0 min-w-0 border-stone-800/55 max-md:block md:hidden">
                <NexusEventLedger
                  nodes={filtered.nodes}
                  highlightId={highlightId}
                  onHighlightChange={setHighlightId}
                />
              </div>
              <div className="hidden min-h-0 w-9 shrink-0 flex-col items-center md:flex">
              <button
                type="button"
                onClick={() => setNoticesOpen(true)}
                title="Show notices"
                className="flex h-full w-full flex-col items-center justify-center gap-2 border-0 bg-stone-950/40 text-stone-500 transition-colors hover:bg-stone-900/60 hover:text-violet-300"
              >
                <Newspaper className="size-4" aria-hidden />
                <span className="font-[family-name:var(--font-nexus-mono)] text-[8px] uppercase tracking-[0.18em] [writing-mode:vertical-rl]">
                  Notices
                </span>
                <ChevronLeft className="size-3" aria-hidden />
              </button>
            </div>
            </>
          )}
        </div>
      </div>

      <NexusTimeBar
        year={year}
        month={month}
        yearMin={meta.yearMin}
        yearMax={meta.yearMax}
        yearCounts={meta.yearCounts}
        monthCountsByYear={meta.monthCountsByYear}
        onYearChange={onYearChange}
        onMonthChange={setMonth}
      />
    </div>
  )
}

export default App
