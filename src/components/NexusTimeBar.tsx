import { Pause, Play } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

type NexusTimeBarProps = {
  year: number
  yearMin: number
  yearMax: number
  /** Record count per year, used to draw the density strip behind the slider. */
  yearCounts: Record<number, number>
  onYearChange: (y: number) => void
}

const PLAY_STEP_MS = 900

export function NexusTimeBar({ year, yearMin, yearMax, yearCounts, onYearChange }: NexusTimeBarProps) {
  const [playing, setPlaying] = useState(false)

  const span = Math.max(1, yearMax - yearMin)
  const recordsThisYear = yearCounts[year] ?? 0

  const bars = useMemo(() => {
    const max = Math.max(1, ...Object.values(yearCounts))
    const out: { year: number; leftPct: number; heightPct: number; count: number }[] = []
    for (let y = yearMin; y <= yearMax; y++) {
      const count = yearCounts[y] ?? 0
      if (count === 0) continue
      out.push({
        year: y,
        leftPct: ((y - yearMin) / span) * 100,
        heightPct: 18 + (count / max) * 82,
        count,
      })
    }
    return out
  }, [yearCounts, yearMin, yearMax, span])

  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => {
      onYearChange(year >= yearMax ? yearMin : year + 1)
    }, PLAY_STEP_MS)
    return () => window.clearInterval(id)
  }, [playing, year, yearMin, yearMax, onYearChange])

  useEffect(() => {
    if (playing && year >= yearMax) setPlaying(false)
  }, [playing, year, yearMax])

  return (
    <div className="z-30 flex shrink-0 items-center gap-4 border-t border-violet-950/35 bg-[#070608]/96 px-4 py-3 backdrop-blur-md">
      <button
        type="button"
        onClick={() => setPlaying((p) => !p)}
        aria-label={playing ? 'Pause timeline' : 'Play timeline'}
        title={playing ? 'Pause' : 'Play through the years'}
        className={`flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors ${
          playing
            ? 'border-violet-500/60 bg-violet-950/60 text-violet-200'
            : 'border-stone-700/70 bg-stone-900/60 text-stone-400 hover:border-violet-700/50 hover:text-violet-200'
        }`}
      >
        {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5 translate-x-px" />}
      </button>

      <div className="hidden min-w-[5.5rem] sm:block">
        <div className="font-[family-name:var(--font-nexus-ui)] text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
          Time axis
        </div>
        <div className="mt-0.5 font-[family-name:var(--font-nexus-mono)] text-xl tabular-nums leading-none text-violet-200">
          {year}
        </div>
        <div className="mt-0.5 font-[family-name:var(--font-nexus-mono)] text-[9px] tabular-nums text-stone-600">
          {recordsThisYear} record{recordsThisYear === 1 ? '' : 's'}
        </div>
      </div>

      <div className="min-w-0 flex flex-1 flex-col gap-0.5">
        <div className="flex justify-between font-[family-name:var(--font-nexus-mono)] text-[9px] tabular-nums text-stone-600">
          <span>{yearMin}</span>
          <span>{yearMax}</span>
        </div>

        <div className="relative">
          {/* Density strip: one bar per year with records, so busy years are visible at a glance. */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-4 h-4">
            {bars.map((bar) => (
              <span
                key={bar.year}
                title={`${bar.year}: ${bar.count}`}
                className={`absolute bottom-0 w-[3px] -translate-x-1/2 rounded-t-sm transition-colors ${
                  bar.year === year ? 'bg-violet-300' : 'bg-violet-700/45'
                }`}
                style={{ left: `${bar.leftPct}%`, height: `${bar.heightPct}%` }}
              />
            ))}
          </div>

          <label className="sr-only" htmlFor="nexus-global-year">
            Simulation year {yearMin}–{yearMax}
          </label>
          <input
            id="nexus-global-year"
            type="range"
            min={yearMin}
            max={yearMax}
            step={1}
            value={year}
            onChange={(e) => onYearChange(Number(e.target.value))}
            className="nexus-slider h-2 w-full cursor-pointer appearance-none rounded-full bg-stone-900 accent-violet-500"
          />
        </div>
      </div>

      <div className="min-w-[3rem] font-[family-name:var(--font-nexus-mono)] text-[11px] tabular-nums text-stone-500 sm:hidden">
        <span aria-hidden>Y</span> {year}
      </div>
    </div>
  )
}
