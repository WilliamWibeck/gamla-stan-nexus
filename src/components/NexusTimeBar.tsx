import { Pause, Play } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { monthLabel, monthShort, shouldShowMonthPicker } from '../lib/nexusDates'

type NexusTimeBarProps = {
  year: number
  month: number | null
  yearMin: number
  yearMax: number
  yearCounts: Record<number, number>
  monthCountsByYear: Record<number, Record<number, number>>
  onYearChange: (y: number) => void
  onMonthChange: (m: number | null) => void
}

const PLAY_STEP_MS = 900

export function NexusTimeBar({
  year,
  month,
  yearMin,
  yearMax,
  yearCounts,
  monthCountsByYear,
  onYearChange,
  onMonthChange,
}: NexusTimeBarProps) {
  const [playing, setPlaying] = useState(false)

  const span = Math.max(1, yearMax - yearMin)
  const recordsThisYear = yearCounts[year] ?? 0
  const monthCounts = monthCountsByYear[year] ?? {}
  const showMonthPicker = shouldShowMonthPicker(recordsThisYear, monthCounts)
  const recordsThisMonth = month != null ? (monthCounts[month] ?? 0) : recordsThisYear

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

  const monthButtons = useMemo(() => {
    const months = Object.keys(monthCounts)
      .map(Number)
      .filter((m) => m >= 1 && m <= 12)
      .sort((a, b) => a - b)
    return months.map((m) => ({ month: m, count: monthCounts[m] ?? 0 }))
  }, [monthCounts])

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

  useEffect(() => {
    if (month != null && !(monthCountsByYear[year]?.[month])) onMonthChange(null)
  }, [year, month, monthCountsByYear, onMonthChange])

  const periodLabel =
    month != null ? `${monthLabel(month)} ${year}` : String(year)

  return (
    <div className="z-30 flex shrink-0 flex-col gap-2 border-t border-violet-950/35 bg-[#070608]/96 px-4 py-3 backdrop-blur-md">
      <div className="flex items-center gap-4">
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
            {periodLabel}
          </div>
          <div className="mt-0.5 font-[family-name:var(--font-nexus-mono)] text-[9px] tabular-nums text-stone-600">
            {recordsThisMonth} record{recordsThisMonth === 1 ? '' : 's'}
            {month != null ? ` · ${recordsThisYear} in ${year}` : ''}
          </div>
        </div>

        <div className="min-w-0 flex flex-1 flex-col gap-0.5">
          <div className="flex justify-between font-[family-name:var(--font-nexus-mono)] text-[9px] tabular-nums text-stone-600">
            <span>{yearMin}</span>
            <span>{yearMax}</span>
          </div>

          <div className="relative">
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
          {periodLabel}
        </div>
      </div>

      {showMonthPicker && monthButtons.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-stone-800/40 pt-2 pl-12 sm:pl-[4.5rem]">
          <span className="mr-1 font-[family-name:var(--font-nexus-mono)] text-[8px] uppercase tracking-[0.14em] text-stone-600">
            Month
          </span>
          <button
            type="button"
            onClick={() => onMonthChange(null)}
            className={`rounded px-2 py-0.5 font-[family-name:var(--font-nexus-mono)] text-[9px] tabular-nums transition-colors ${
              month == null
                ? 'bg-violet-900/50 text-violet-200 ring-1 ring-violet-600/40'
                : 'bg-stone-900/60 text-stone-500 hover:text-stone-300'
            }`}
          >
            All {year}
          </button>
          {monthButtons.map(({ month: m, count }) => (
            <button
              key={m}
              type="button"
              title={`${monthLabel(m)} ${year}: ${count}`}
              onClick={() => onMonthChange(m)}
              className={`rounded px-2 py-0.5 font-[family-name:var(--font-nexus-mono)] text-[9px] tabular-nums transition-colors ${
                month === m
                  ? 'bg-violet-900/50 text-violet-200 ring-1 ring-violet-600/40'
                  : 'bg-stone-900/60 text-stone-500 hover:text-stone-300'
              }`}
            >
              {monthShort(m)}
              <span className="ml-1 text-[8px] text-stone-600">{count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
