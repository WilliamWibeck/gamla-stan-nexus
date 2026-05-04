import { Building2, Crown, Landmark, Layers, Radar, TriangleAlert } from 'lucide-react'

type NexusSidebarProps = {
  filterThemes: string[]
  /** Empty set ⇒ show every theme */
  activeThemes: Set<string>
  onToggleTheme: (theme: string) => void
  onClearThemes: () => void
}

const THEME_META: Partial<Record<string, { label: string; icon: typeof Layers }>> = {
  'Daily Life': { label: 'Daily life', icon: Landmark },
  'Security Threats': { label: 'Security', icon: Radar },
  'Court & State': { label: 'Court', icon: Crown },
  Conspiracy: { label: 'Plot', icon: TriangleAlert },
}

export function NexusSidebar({ filterThemes, activeThemes, onToggleTheme, onClearThemes }: NexusSidebarProps) {
  const filtering = activeThemes.size > 0

  return (
    <aside
      id="nexus-control-panel"
      className="pointer-events-auto flex h-full w-[min(11rem,24vw)] min-w-[9.5rem] max-w-[18vw] shrink-0 flex-col border-r border-violet-950/35 bg-[#070608]/94 shadow-[inset_-1px_0_0_rgba(168,85,247,0.06)] backdrop-blur-md"
    >
      <header className="border-b border-stone-800/70 px-3 py-3">
        <h1 className="font-[family-name:var(--font-nexus-serif)] text-lg font-semibold tracking-[0.04em] text-stone-100">
          Nexus
        </h1>
        <p className="mt-1 font-[family-name:var(--font-nexus-mono)] text-[8px] uppercase leading-tight tracking-[0.16em] text-violet-300/65">
          Split-view engine
        </p>
      </header>

      <div className="flex flex-col gap-3 px-2.5 py-3">
        <div className="flex items-center gap-1.5 px-1">
          <Layers className="size-3.5 shrink-0 text-violet-400/80" aria-hidden />
          <span className="font-[family-name:var(--font-nexus-ui)] text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400">
            Threads
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={onClearThemes}
            className={
              filtering
                ? 'mb-1 rounded border border-amber-800/35 bg-stone-900/50 px-2 py-1 font-[family-name:var(--font-nexus-mono)] text-[9px] text-amber-100/85 transition-colors hover:bg-stone-800/70'
                : 'mb-1 rounded border border-transparent px-2 py-1 font-[family-name:var(--font-nexus-mono)] text-[9px] text-stone-500'
            }
          >
            {filtering ? 'Show all dossiers' : 'All dossiers'}
          </button>

          <ul className="flex flex-col gap-1">
            {filterThemes.map((theme) => {
              const on = filtering && activeThemes.has(theme)
              const meta = THEME_META[theme] ?? { label: theme, icon: Building2 }
              const Icon = meta.icon ?? Building2
              return (
                <li key={theme}>
                  <button
                    type="button"
                    onClick={() => onToggleTheme(theme)}
                    aria-pressed={on}
                    className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left transition-[border-color,background-color] ${
                      on
                        ? 'border-violet-500/50 bg-violet-950/40'
                        : 'border-transparent bg-stone-900/35 hover:bg-stone-900/65'
                    }`}
                  >
                    <Icon
                      className={`size-3.5 shrink-0 ${on ? 'text-violet-200' : 'text-stone-500'}`}
                      aria-hidden
                    />
                    <span className="font-[family-name:var(--font-nexus-ui)] text-[11px] leading-snug text-stone-200/95">
                      {meta.label ?? theme}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="mt-auto rounded border border-stone-800/60 bg-stone-950/40 px-2 py-2">
          <p className="font-[family-name:var(--font-nexus-mono)] text-[8px] uppercase leading-relaxed tracking-wider text-stone-600">
            Map ↔ graph highlight when you skim entities. Time axis is docked globally.
          </p>
        </div>
      </div>
    </aside>
  )
}
