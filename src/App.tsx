import { useCallback, useEffect, useMemo, useState } from 'react'

import gustavIII from './data/gustav_iii_poc.json'
import { NexusMindmap } from './components/NexusMindmap'
import { NexusSidebar } from './components/NexusSidebar'
import { NexusMap } from './components/NexusMap'
import { NexusTimeBar } from './components/NexusTimeBar'
import {
  filterPocDataset,
  mapHighlightTargetId,
  type PocLink,
  type PocDataset,
  type PocNode,
  toForceGraphData,
  toMapNexusGraph,
} from './lib/nexusPoc'

const POC = gustavIII as PocDataset

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

function relationshipToTheme(relationship: string): string {
  if (relationship === 'lived_in') return 'Residency'
  if (relationship === 'related_to') return 'Kinship'
  if (relationship === 'witnessed') return 'Events'
  return 'General'
}

function toPocDatasetFromMaster(master: MasterDataset): PocDataset {
  const nodes: PocNode[] = master.nodes.map((n) => ({
    id: n.id,
    name: n.label,
    kind: n.type,
    lat: typeof n.lat === 'number' ? n.lat : null,
    lng: typeof n.lng === 'number' ? n.lng : null,
    yearStart: 1750,
    yearEnd: 1850,
    themes: Array.isArray(n.metadata?.themes)
      ? (n.metadata?.themes as string[])
      : ['General'],
    markerType: n.type === 'event' ? 'event' : 'residence',
  }))

  const links: PocLink[] = master.links.map((l) => ({
    source: l.source,
    target: l.target,
    label: l.relationship,
    themes: [relationshipToTheme(l.relationship)],
  }))

  const allThemes = new Set<string>()
  for (const n of nodes) for (const t of n.themes) allThemes.add(t)
  for (const l of links) for (const t of l.themes ?? []) allThemes.add(t)

  return {
    meta: {
      yearMin: 1750,
      yearMax: 1850,
      filterThemes: [...allThemes],
    },
    nodes,
    links,
  }
}

function App() {
  const [master, setMaster] = useState<MasterDataset | null>(null)
  const [poc, setPoc] = useState<PocDataset>(POC)
  const [year, setYear] = useState<number>(1792)
  const [activeThemes, setActiveThemes] = useState<Set<string>>(() => new Set())
  const [highlightId, setHighlightId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/nexus_master.json', { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as MasterDataset
        if (cancelled || !Array.isArray(data.nodes) || !Array.isArray(data.links)) return
        setMaster(data)
        setPoc(toPocDatasetFromMaster(data))
        setYear(1792)
      } catch {
        /* keep bundled fallback dataset */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const meta = poc.meta
  const filtered = useMemo(
    () => filterPocDataset(poc, year, activeThemes),
    [poc, year, activeThemes],
  )
  const mapGraph = useMemo(() => toMapNexusGraph(filtered), [filtered])
  const mindGraph = useMemo(() => toForceGraphData(filtered), [filtered])
  const highlightMapTargetId = mapHighlightTargetId(highlightId, filtered)

  const toggleTheme = useCallback((theme: string) => {
    setActiveThemes((prev) => {
      const n = new Set(prev)
      if (n.has(theme)) n.delete(theme)
      else n.add(theme)
      return n
    })
  }, [])

  const clearThemes = useCallback(() => setActiveThemes(new Set()), [])

  const onMarkerHover = useCallback((id: string | null) => setHighlightId(id), [])

  return (
    <div className="flex h-dvh min-h-dvh w-full flex-col overflow-hidden bg-[#09080b] text-stone-200">
      <div className="flex min-h-0 min-w-0 flex-1">
        <NexusSidebar
          filterThemes={meta.filterThemes}
          activeThemes={activeThemes}
          onToggleTheme={toggleTheme}
          onClearThemes={clearThemes}
        />

        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1">
          <div className="relative min-h-0 min-w-0 border-b border-stone-800/55 md:border-b-0 md:border-r">
            <NexusMap
              mapGraph={mapGraph}
              highlightTargetId={highlightMapTargetId}
              onMarkerHover={onMarkerHover}
            />
          </div>

          <div className="relative min-h-0 min-w-0 border-stone-800/55 md:border-t-0">
            <NexusMindmap
              data={mindGraph}
              highlightId={highlightId}
              onHighlightChange={setHighlightId}
            />
          </div>
        </div>
      </div>

      <NexusTimeBar year={year} yearMin={meta.yearMin} yearMax={meta.yearMax} onYearChange={setYear} />
    </div>
  )
}

export default App
