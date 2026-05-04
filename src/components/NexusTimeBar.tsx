type NexusTimeBarProps = {
  year: number
  yearMin: number
  yearMax: number
  onYearChange: (y: number) => void
}

export function NexusTimeBar({ year, yearMin, yearMax, onYearChange }: NexusTimeBarProps) {
  return (
    <div className="z-30 flex shrink-0 items-center gap-6 border-t border-violet-950/35 bg-[#070608]/96 px-4 py-3 backdrop-blur-md">
      <div className="hidden min-w-[5.5rem] sm:block">
        <div className="font-[family-name:var(--font-nexus-ui)] text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
          Time axis
        </div>
        <div className="mt-0.5 font-[family-name:var(--font-nexus-mono)] text-xl tabular-nums leading-none text-violet-200">
          {year}
        </div>
      </div>

      <div className="min-w-0 flex flex-1 flex-col gap-1">
        <div className="flex justify-between font-[family-name:var(--font-nexus-mono)] text-[9px] tabular-nums text-stone-600">
          <span>{yearMin}</span>
          <span>{yearMax}</span>
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

      <div className="min-w-[3rem] font-[family-name:var(--font-nexus-mono)] text-[11px] tabular-nums text-stone-500 sm:hidden">
        <span aria-hidden>Y</span> {year}
      </div>
    </div>
  )
}
