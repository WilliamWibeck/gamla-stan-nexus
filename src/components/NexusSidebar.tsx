import { Layers } from 'lucide-react'

import { NEXUS_CATEGORIES, type CategoryId } from '../lib/nexusCategories'

type NexusSidebarProps = {
  categoryCounts: Partial<Record<CategoryId, number>>
  /** Empty set ⇒ show every category */
  activeCategories: Set<CategoryId>
  onToggleCategory: (category: CategoryId) => void
  onClearCategories: () => void
}

export function NexusSidebar({
  categoryCounts,
  activeCategories,
  onToggleCategory,
  onClearCategories,
}: NexusSidebarProps) {
  const filtering = activeCategories.size > 0
  const visible = NEXUS_CATEGORIES.filter((c) => (categoryCounts[c.id] ?? 0) > 0)

  return (
    <aside
      id="nexus-control-panel"
      className="pointer-events-auto flex h-full w-[min(12rem,26vw)] min-w-[10.5rem] max-w-[20vw] shrink-0 flex-col border-r border-violet-950/35 bg-[#070608]/94 shadow-[inset_-1px_0_0_rgba(168,85,247,0.06)] backdrop-blur-md"
    >
      <header className="border-b border-stone-800/70 px-3 py-3">
        <h1 className="font-[family-name:var(--font-nexus-serif)] text-lg font-semibold tracking-[0.04em] text-stone-100">
          Nexus
        </h1>
        <p className="mt-1 font-[family-name:var(--font-nexus-mono)] text-[8px] uppercase leading-tight tracking-[0.16em] text-violet-300/65">
          Gamla Stan archive
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-2.5 py-3">
        <div className="flex items-center gap-1.5 px-1">
          <Layers className="size-3.5 shrink-0 text-violet-400/80" aria-hidden />
          <span className="font-[family-name:var(--font-nexus-ui)] text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400">
            Categories
          </span>
        </div>

        <div className="flex min-h-0 flex-col gap-1 overflow-y-auto custom-scrollbar">
          <button
            type="button"
            onClick={onClearCategories}
            className={
              filtering
                ? 'mb-1 shrink-0 rounded border border-amber-800/35 bg-stone-900/50 px-2 py-1 font-[family-name:var(--font-nexus-mono)] text-[9px] text-amber-100/85 transition-colors hover:bg-stone-800/70'
                : 'mb-1 shrink-0 rounded border border-transparent px-2 py-1 font-[family-name:var(--font-nexus-mono)] text-[9px] text-stone-500'
            }
          >
            {filtering ? 'Show all categories' : 'All categories'}
          </button>

          <ul className="flex flex-col gap-1">
            {visible.map((category) => {
              const on = filtering && activeCategories.has(category.id)
              const dimmed = filtering && !on
              const count = categoryCounts[category.id] ?? 0
              return (
                <li key={category.id}>
                  <button
                    type="button"
                    onClick={() => onToggleCategory(category.id)}
                    aria-pressed={on}
                    title={category.description}
                    className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left transition-[border-color,background-color,opacity] ${
                      on
                        ? 'border-stone-500/40 bg-stone-800/60'
                        : 'border-transparent bg-stone-900/35 hover:bg-stone-900/65'
                    } ${dimmed ? 'opacity-45' : ''}`}
                  >
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-full"
                      style={{
                        background: category.color,
                        boxShadow: on || !filtering ? `0 0 6px ${category.color}` : 'none',
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-nexus-ui)] text-[11px] leading-snug text-stone-200/95">
                      {category.label}
                    </span>
                    <span className="shrink-0 font-[family-name:var(--font-nexus-mono)] text-[9px] tabular-nums text-stone-500">
                      {count}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="mt-auto shrink-0 rounded border border-stone-800/60 bg-stone-950/40 px-2 py-2">
          <p className="font-[family-name:var(--font-nexus-mono)] text-[8px] uppercase leading-relaxed tracking-wider text-stone-600">
            Colors match map pins, graph nodes and notice list entries. Hover to cross-highlight.
          </p>
        </div>
      </div>
    </aside>
  )
}
