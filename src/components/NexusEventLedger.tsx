import { Calendar, MapPin, MapPinOff, Newspaper, Languages, ChevronDown, ChevronUp } from 'lucide-react'
import { categoryById } from '../lib/nexusCategories'
import type { PocNode } from '../lib/nexusPoc'
import { useMemo, useState } from 'react'

type NexusEventLedgerProps = {
  nodes: PocNode[]
  highlightId: string | null
  onHighlightChange: (id: string | null) => void
}

function eventDate(n: PocNode): string {
  const meta = n.metadata || {}
  const inner = (meta.metadata as Record<string, unknown>) || {}
  const d = meta.date ?? meta.year ?? inner.date
  return typeof d === 'string' ? d : ''
}

export function NexusEventLedger({ nodes, highlightId, onHighlightChange }: NexusEventLedgerProps) {
  const events = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === 'event' && !n.ghost)
        .sort((a, b) => eventDate(a).localeCompare(eventDate(b)) || a.name.localeCompare(b.name)),
    [nodes],
  )
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)

  const handleToggleExpand = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null)
    } else {
      setExpandedId(id)
      onHighlightChange(id)
    }
  }

  return (
    <div className="flex h-full flex-col bg-[#070608]/40 backdrop-blur-md">
      <header className="flex shrink-0 items-center gap-2 border-b border-stone-800/50 px-4 py-3">
        <Newspaper className="size-4 text-violet-400" aria-hidden />
        <h2 className="font-[family-name:var(--font-nexus-serif)] text-sm font-semibold tracking-wide text-stone-200">
          Evidence Ledger
        </h2>
        <span className="ml-auto font-[family-name:var(--font-nexus-mono)] text-[10px] text-stone-500">
          {events.length} entries
        </span>
      </header>

      <div className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar">
        {events.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <p className="font-[family-name:var(--font-nexus-mono)] text-[11px] leading-relaxed text-stone-600">
              No active events found for this time period or dossier.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-stone-800/30">
            {events.map((event) => {
              const isHighlighted = highlightId === event.id
              const isExpanded = expandedId === event.id
              const hasCoords = event.lat !== null && event.lng !== null
              const category = categoryById(event.category)

              const meta = event.metadata || {}
              const description = meta.description as string
              const innerMeta = (meta.metadata as Record<string, unknown>) || {}
              const originalSpelling = innerMeta.original_spelling as string
              const date = eventDate(event)

              return (
                <li key={event.id} className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => handleToggleExpand(event.id)}
                    onMouseEnter={() => !isExpanded && onHighlightChange(event.id)}
                    onMouseLeave={() => !isExpanded && onHighlightChange(null)}
                    className={`group flex w-full flex-col gap-1.5 px-4 py-3.5 text-left transition-colors ${
                      isHighlighted || isExpanded ? 'bg-violet-950/20' : 'hover:bg-stone-900/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span
                        className={`font-[family-name:var(--font-nexus-serif)] text-[13px] leading-snug transition-colors ${
                          isHighlighted || isExpanded ? 'text-violet-200' : 'text-stone-300 group-hover:text-stone-100'
                        }`}
                      >
                        {event.name}
                      </span>
                      <div className="flex items-center gap-2">
                        {hasCoords ? (
                          <MapPin className="size-3 shrink-0 text-cyan-500/60" aria-hidden />
                        ) : (
                          <MapPinOff className="size-3 shrink-0 text-stone-600" aria-hidden />
                        )}
                        {isExpanded ? (
                          <ChevronUp className="size-3 text-stone-500" />
                        ) : (
                          <ChevronDown className="size-3 text-stone-500" />
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-1.5">
                        <Calendar className="size-3 text-stone-500" aria-hidden />
                        <span className="font-[family-name:var(--font-nexus-mono)] text-[10px] tabular-nums text-stone-500">
                          {date || event.yearStart}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className="size-1.5 rounded-full"
                          style={{ background: category.color, boxShadow: `0 0 4px ${category.color}` }}
                        />
                        <span
                          className="font-[family-name:var(--font-nexus-mono)] text-[9px] uppercase tracking-wider"
                          style={{ color: category.color }}
                        >
                          {category.label}
                        </span>
                      </div>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-stone-800/30 bg-stone-950/40 px-4 py-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-stone-500">
                          <Languages className="size-3" />
                          <span className="font-[family-name:var(--font-nexus-mono)] text-[9px] uppercase tracking-wider">
                            {showOriginal ? 'Historical Record' : 'Modern Summary'}
                          </span>
                        </div>
                        {originalSpelling && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setShowOriginal(!showOriginal)
                            }}
                            className="rounded border border-stone-700 bg-stone-900 px-2 py-0.5 font-[family-name:var(--font-nexus-mono)] text-[9px] text-stone-400 hover:bg-stone-800 hover:text-stone-200"
                          >
                            Switch to {showOriginal ? 'Modern' : 'Old'} Swedish
                          </button>
                        )}
                      </div>

                      <p className={`font-[family-name:var(--font-nexus-serif)] text-[12px] leading-relaxed text-stone-300 ${showOriginal ? 'italic' : ''}`}>
                        {showOriginal ? originalSpelling : description || 'No description available.'}
                      </p>

                      {/* Displaying additional metadata if available */}
                      {(typeof innerMeta.record_type === 'string' ||
                        typeof innerMeta.crime === 'string' ||
                        typeof innerMeta.suspect === 'string' ||
                        typeof innerMeta.victim === 'string' ||
                        typeof innerMeta.fire_cause === 'string' ||
                        typeof innerMeta.damage_level === 'string' ||
                        typeof innerMeta.parish_event === 'string') && (
                        <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-[family-name:var(--font-nexus-mono)] text-stone-400">
                          {typeof innerMeta.record_type === 'string' && innerMeta.record_type && (
                            <span className="rounded bg-stone-900 border border-stone-800/60 px-2 py-0.5">
                              Doc: <span className="text-violet-300">{innerMeta.record_type}</span>
                            </span>
                          )}
                          {typeof innerMeta.crime === 'string' && innerMeta.crime && (
                            <span className="rounded bg-stone-900 border border-stone-800/60 px-2 py-0.5">
                              Crime: <span className="text-red-300">{innerMeta.crime}</span>
                            </span>
                          )}
                          {typeof innerMeta.suspect === 'string' && innerMeta.suspect && (
                            <span className="rounded bg-stone-900 border border-stone-800/60 px-2 py-0.5">
                              Suspect: <span className="text-stone-300">{innerMeta.suspect}</span>
                            </span>
                          )}
                          {typeof innerMeta.victim === 'string' && innerMeta.victim && (
                            <span className="rounded bg-stone-900 border border-stone-800/60 px-2 py-0.5">
                              Victim: <span className="text-stone-300">{innerMeta.victim}</span>
                            </span>
                          )}
                          {typeof innerMeta.fire_cause === 'string' && innerMeta.fire_cause && (
                            <span className="rounded bg-stone-900 border border-stone-800/60 px-2 py-0.5">
                              Cause: <span className="text-orange-300">{innerMeta.fire_cause}</span>
                            </span>
                          )}
                          {typeof innerMeta.damage_level === 'string' && innerMeta.damage_level && (
                            <span className="rounded bg-stone-900 border border-stone-800/60 px-2 py-0.5">
                              Damage: <span className="text-stone-300">{innerMeta.damage_level}</span>
                            </span>
                          )}
                          {typeof innerMeta.parish_event === 'string' && innerMeta.parish_event && (
                            <span className="rounded bg-stone-900 border border-stone-800/60 px-2 py-0.5">
                              Event: <span className="text-emerald-300">{innerMeta.parish_event}</span>
                            </span>
                          )}
                        </div>
                      )}

                      {!hasCoords && (
                        <div className="mt-4 rounded border border-stone-800/50 bg-stone-900/30 px-3 py-2">
                          <p className="font-[family-name:var(--font-nexus-mono)] text-[9px] leading-relaxed text-stone-500">
                            Geographic context: Mentions <span className="text-stone-400">{meta.address as string || 'Unknown location'}</span>. Precise coordinates currently being determined from archival cross-referencing.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
