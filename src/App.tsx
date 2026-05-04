import { useCallback, useMemo, useState } from 'react'

import gustavIII from './data/gustav_iii_poc.json'
import { NexusMindmap } from './components/NexusMindmap'
import { NexusSidebar } from './components/NexusSidebar'
import { NexusMap } from './components/NexusMap'
import { NexusTimeBar } from './components/NexusTimeBar'
import {
  filterPocDataset,
  mapHighlightTargetId,
  type PocDataset,
  toForceGraphData,
  toMapNexusGraph,
} from './lib/nexusPoc'

const POC = gustavIII as PocDataset

function App() {
  const meta = POC.meta
  const [year, setYear] = useState<number>(1792)
  const [activeThemes, setActiveThemes] = useState<Set<string>>(() => new Set())
  const [highlightId, setHighlightId] = useState<string | null>(null)

  const filtered = useMemo(
    () => filterPocDataset(POC, year, activeThemes),
    [year, activeThemes],
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
