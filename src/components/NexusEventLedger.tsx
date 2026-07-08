import {
  Calendar,
  MapPin,
  MapPinOff,
  Newspaper,
  Languages,
  ChevronDown,
  ChevronUp,
  ChevronRight,
} from 'lucide-react'
import { categoryById } from '../lib/nexusCategories'
import { formatEventDate, monthLabel } from '../lib/nexusDates'
import type { PocNode } from '../lib/nexusPoc'
import { useMemo, useState } from 'react'

type NexusEventLedgerProps = {
  nodes: PocNode[]
  highlightId: string | null
  onHighlightChange: (id: string | null) => void
  onCollapse?: () => void
}

function eventDateIso(n: PocNode): string | null {
  if (n.dateStart) return n.dateStart
  const meta = n.metadata || {}
  const inner = (meta.metadata as Record<string, unknown>) || {}
  const d = meta.date ?? meta.year ?? inner.date
  if (typeof d !== 'string') return null
  const match = d.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : null
}

function monthGroupKey(iso: string | null, yearStart: number): string {
  if (iso && iso.length >= 7) return iso.slice(0, 7)
  return `year-${yearStart}`
}

function monthGroupLabel(key: string, yearStart: number): string {
  if (key.startsWith('year-')) return String(yearStart)
  const [y, m] = key.split('-').map(Number)
  if (m >= 1 && m <= 12) return `${monthLabel(m)} ${y}`
  return key
}

export function NexusEventLedger({ nodes, highlightId, onHighlightChange, onCollapse }: NexusEventLedgerProps) {
  const events = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === 'event' && !n.ghost)
        .sort(
          (a, b) =>
            (eventDateIso(a) ?? '').localeCompare(eventDateIso(b) ?? '') ||
            a.name.localeCompare(b.name),
        ),
    [nodes],
  )

  const groupedEvents = useMemo(() => {
    const groups = new Map<string, PocNode[]>()
    for (const event of events) {
      const iso = eventDateIso(event)
      const key = monthGroupKey(iso, event.yearStart)
      const list = groups.get(key) ?? []
      list.push(event)
      groups.set(key, list)
    }
    return [...groups.entries()]
  }, [events])

  const useMonthGroups = groupedEvents.length > 1

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

  const renderEvent = (event: PocNode) => {
    const isHighlighted = highlightId === event.id
    const isExpanded = expandedId === event.id
    const hasCoords = event.lat !== null && event.lng !== null
    const category = categoryById(event.category)

    const meta = event.metadata || {}
    const description = meta.description as string
    const innerMeta = (meta.metadata as Record<string, unknown>) || {}
    const originalSpelling = innerMeta.original_spelling as string
    const date = formatEventDate(eventDateIso(event), event.yearStart)

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
                {date}
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
                  {showOriginal ? 'Historical Record' : 'Modern Text'}
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

            <p
              className={`font-[family-name:var(--font-nexus-serif)] text-[12px] leading-relaxed text-stone-300 ${showOriginal ? 'italic' : ''}`}
            >
              {showOriginal ? originalSpelling : description || 'No description available.'}
            </p>

            {(typeof innerMeta.record_type === 'string' ||
              typeof innerMeta.crime === 'string' ||
              typeof innerMeta.suspect === 'string' ||
              typeof innerMeta.victim === 'string' ||
              typeof innerMeta.fire_cause === 'string' ||
              typeof innerMeta.damage_level === 'string' ||
              typeof innerMeta.parish_event === 'string') && (
              <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-[family-name:var(--font-nexus-mono)] text-stone-400">
                {typeof innerMeta.record_type === 'string' && innerMeta.record_type && (
                  <span className="rounded border border-stone-800/60 bg-stone-900 px-2 py-0.5">
                    Doc: <span className="text-violet-300">{innerMeta.record_type}</span>
                  </span>
                )}
                {typeof innerMeta.crime === 'string' && innerMeta.crime && (
                  <span className="rounded border border-stone-800/60 bg-stone-900 px-2 py-0.5">
                    Crime: <span className="text-red-300">{innerMeta.crime}</span>
                  </span>
                )}
                {typeof innerMeta.suspect === 'string' && innerMeta.suspect && (
                  <span className="rounded border border-stone-800/60 bg-stone-900 px-2 py-0.5">
                    Suspect: <span className="text-stone-300">{innerMeta.suspect}</span>
                  </span>
                )}
                {typeof innerMeta.victim === 'string' && innerMeta.victim && (
                  <span className="rounded border border-stone-800/60 bg-stone-900 px-2 py-0.5">
                    Victim: <span className="text-stone-300">{innerMeta.victim}</span>
                  </span>
                )}
                {typeof innerMeta.fire_cause === 'string' && innerMeta.fire_cause && (
                  <span className="rounded border border-stone-800/60 bg-stone-900 px-2 py-0.5">
                    Cause: <span className="text-orange-300">{innerMeta.fire_cause}</span>
                  </span>
                )}
                {typeof innerMeta.damage_level === 'string' && innerMeta.damage_level && (
                  <span className="rounded border border-stone-800/60 bg-stone-900 px-2 py-0.5">
                    Damage: <span className="text-stone-300">{innerMeta.damage_level}</span>
                  </span>
                )}
                {typeof innerMeta.parish_event === 'string' && innerMeta.parish_event && (
                  <span className="rounded border border-stone-800/60 bg-stone-900 px-2 py-0.5">
                    Event: <span className="text-emerald-300">{innerMeta.parish_event}</span>
                  </span>
                )}
              </div>
            )}

            {!hasCoords && (
              <div className="mt-4 rounded border border-stone-800/50 bg-stone-900/30 px-3 py-2">
                <p className="font-[family-name:var(--font-nexus-mono)] text-[9px] leading-relaxed text-stone-500">
                  Geographic context: Mentions{' '}
                  <span className="text-stone-400">{(meta.address as string) || 'Unknown location'}</span>.
                  Precise coordinates currently being determined from archival cross-referencing.
                </p>
              </div>
            )}
          </div>
        )}
      </li>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[#070608]/40 backdrop-blur-md">
      <header className="flex shrink-0 items-center gap-2 border-b border-stone-800/50 px-4 py-3">
        <Newspaper className="size-4 text-violet-400" aria-hidden />
        <div className="min-w-0">
          <h2 className="font-[family-name:var(--font-nexus-serif)] text-sm font-semibold tracking-wide text-stone-200">
            Notices
          </h2>
          <p className="font-[family-name:var(--font-nexus-mono)] text-[8px] uppercase tracking-[0.14em] text-stone-600">
            Tidningsnotiser
          </p>
        </div>
        <span className="ml-auto font-[family-name:var(--font-nexus-mono)] text-[10px] text-stone-500">
          {events.length}
        </span>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title="Collapse notices"
            className="rounded border border-stone-700/70 bg-stone-950/80 p-1.5 text-stone-400 transition-colors hover:border-stone-600 hover:text-stone-100"
          >
            <ChevronRight className="size-3.5" aria-hidden />
          </button>
        )}
      </header>

      <div className="custom-scrollbar flex-1 overflow-x-hidden overflow-y-auto">
        {events.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <p className="font-[family-name:var(--font-nexus-mono)] text-[11px] leading-relaxed text-stone-600">
              No active events found for this time period or dossier.
            </p>
          </div>
        ) : useMonthGroups ? (
          <div className="divide-y divide-stone-800/30">
            {groupedEvents.map(([key, group]) => (
              <section key={key}>
                <div className="sticky top-0 z-10 border-b border-stone-800/40 bg-[#070608]/95 px-4 py-2 backdrop-blur-sm">
                  <h3 className="font-[family-name:var(--font-nexus-mono)] text-[9px] uppercase tracking-[0.16em] text-stone-500">
                    {monthGroupLabel(key, group[0]?.yearStart ?? 0)}
                    <span className="ml-2 text-stone-600">{group.length}</span>
                  </h3>
                </div>
                <ul className="divide-y divide-stone-800/20">{group.map(renderEvent)}</ul>
              </section>
            ))}
          </div>
        ) : (
          <ul className="divide-y divide-stone-800/30">{events.map(renderEvent)}</ul>
        )}
      </div>
    </div>
  )
}
