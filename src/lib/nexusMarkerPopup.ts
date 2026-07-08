import type { PopupOptions } from 'mapbox-gl'

import { categoryById } from './nexusCategories'
import { markerColor, type NexusNode, type NexusNodeType } from './nexusHistoricalGraph'

export type MapMarkerNode = NexusNode & {
  kind?: 'person' | 'place' | 'event'
  themes?: string[]
  yearStart?: number
  yearEnd?: number
  metadata?: Record<string, unknown>
}

const FIELD_LABELS: Record<string, string> = {
  date: 'Date',
  year: 'Year',
  address: 'Address',
  resident: 'Person mentioned',
  description: 'Summary',
  source_paper: 'Publication',
  archive_ref: 'Archive reference',
  original_spelling: 'Original text',
  themes: 'Themes',
  _source_file: 'Extracted from',
  source_file: 'Source file',
  source: 'Data source',
  kvarter: 'Quarter',
  role: 'Role',
  lat: 'Latitude',
  lng: 'Longitude',
  period: 'Period',
  relationship: 'Relationship',
  strength: 'Link strength',
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function humanizeKey(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key]
  return key
    .replace(/^_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatScalar(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function formatThemes(node: MapMarkerNode): string[] {
  const themes = new Set<string>()
  for (const t of node.themes ?? []) themes.add(t)
  const meta = node.metadata ?? {}
  const inner = (meta.metadata as Record<string, unknown> | undefined) ?? {}
  for (const source of [meta.themes, inner.themes, meta.theme]) {
    if (Array.isArray(source)) {
      for (const t of source) if (typeof t === 'string' && t.trim()) themes.add(t.trim())
    } else if (typeof source === 'string' && source.trim()) {
      themes.add(source.trim())
    }
  }
  return [...themes]
}

function readMetaString(node: MapMarkerNode, ...keys: string[]): string | null {
  const meta = node.metadata ?? {}
  const inner = (meta.metadata as Record<string, unknown> | undefined) ?? {}
  for (const key of keys) {
    const outer = formatScalar(meta[key])
    if (outer) return outer
    const nested = formatScalar(inner[key])
    if (nested) return nested
  }
  return null
}

type DetailRow = { label: string; value: string }

function collectDetailRows(node: MapMarkerNode): DetailRow[] {
  const rows: DetailRow[] = []
  const seen = new Set<string>()

  const add = (key: string, label: string, value: unknown) => {
    const formatted = formatScalar(value)
    if (!formatted) return
    if (key === 'label' && formatted === node.name) return
    if (seen.has(key)) return
    seen.add(key)
    rows.push({ label, value: formatted })
  }

  const skipTopLevel = new Set([
    'description',
    'label',
    'metadata',
    'themes',
    'theme',
    'original_spelling',
    'lat',
    'lng',
  ])

  const walk = (obj: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'metadata' && value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>)
        continue
      }
      if (skipTopLevel.has(key)) continue
      if (Array.isArray(value)) {
        const joined = value
          .map((item) => formatScalar(item))
          .filter((item): item is string => Boolean(item))
          .join(', ')
        if (joined) add(key, humanizeKey(key), joined)
        continue
      }
      if (value && typeof value === 'object') {
        walk(value as Record<string, unknown>)
        continue
      }
      add(key, humanizeKey(key), value)
    }
  }

  if (node.metadata) walk(node.metadata)

  if (!readMetaString(node, 'date', 'year') && node.yearStart != null) {
    const range =
      node.yearEnd != null && node.yearEnd !== node.yearStart
        ? `${node.yearStart}–${node.yearEnd}`
        : String(node.yearStart)
    add('year_range', 'Year', range)
  }

  return rows
}

function kindLabel(kind: MapMarkerNode['kind'], fallback: NexusNodeType): string {
  if (kind === 'person') return 'Person'
  if (kind === 'place') return 'Place'
  if (kind === 'event') return 'Event'
  if (fallback === 'event') return 'Event'
  if (fallback === 'security') return 'Security'
  return 'Location'
}

function themeTagsHtml(themes: string[]): string {
  if (themes.length === 0) return ''
  return `<div class="nexus-node-popup-tags">${themes
    .map(
      (theme) =>
        `<span class="nexus-node-popup-tag">${escapeHtml(theme)}</span>`,
    )
    .join('')}</div>`
}

function detailRowsHtml(rows: DetailRow[]): string {
  if (rows.length === 0) return ''
  return `<dl class="nexus-node-popup-details">${rows
    .map(
      ({ label, value }) =>
        `<div class="nexus-node-popup-detail"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join('')}</dl>`
}

export function markerPopupHtml(node: MapMarkerNode): string {
  const date = readMetaString(node, 'date', 'year')
  const address = readMetaString(node, 'address')
  const description = readMetaString(node, 'description')
  const originalSpelling = readMetaString(node, 'original_spelling')
  const resident = readMetaString(node, 'resident')
  const themes = formatThemes(node)
  const details = collectDetailRows(node)
  const accent = markerColor(node)
  const typeLabel = node.category ? categoryById(node.category).label : kindLabel(node.kind, node.type)

  const kickerParts = [typeLabel]
  if (date) kickerParts.push(date)
  if (address) kickerParts.push(address)

  const originalBlock =
    originalSpelling && originalSpelling !== description
      ? `<section class="nexus-node-popup-section">
           <h4 class="nexus-node-popup-section-title">Original text</h4>
           <p class="nexus-node-popup-original">${escapeHtml(originalSpelling)}</p>
         </section>`
      : ''

  const descriptionBlock = description
    ? `<section class="nexus-node-popup-section">
         <h4 class="nexus-node-popup-section-title">${originalSpelling && originalSpelling !== description ? 'Modern text' : 'Summary'}</h4>
         <p class="nexus-node-popup-description">${escapeHtml(description)}</p>
       </section>`
    : ''

  const residentBlock = resident
    ? `<p class="nexus-node-popup-resident"><span>Mentioned</span> ${escapeHtml(resident)}</p>`
    : ''

  return `<div class="nexus-node-popup">
    <header class="nexus-node-popup-header">
      <div class="nexus-node-popup-kicker" style="color:${accent}">${escapeHtml(kickerParts.join(' · '))}</div>
      <h3 class="nexus-node-popup-title">${escapeHtml(node.name)}</h3>
      ${themeTagsHtml(themes)}
      ${residentBlock}
    </header>
    ${descriptionBlock}
    ${originalBlock}
    ${detailRowsHtml(details)}
  </div>`
}

export function markerPopupOptions(): PopupOptions {
  return {
    offset: 14,
    closeButton: true,
    closeOnClick: false,
    className: 'nexus-popup nexus-node-popup-shell',
    maxWidth: '420px',
  }
}

export function clusterListPopupHtml(
  nodes: MapMarkerNode[],
  anchorPlace?: string | null,
): string {
  const placeLine = anchorPlace
    ? `<p class="nexus-cluster-popup-place">${escapeHtml(anchorPlace)} · ${nodes.length} notices</p>`
    : `<p class="nexus-cluster-popup-place">${nodes.length} notices at this location</p>`

  const items = nodes
    .map((node) => {
      const cat = categoryById(node.category)
      const date = readMetaString(node, 'date', 'year')
      return `<button type="button" class="nexus-cluster-popup-item" data-node-id="${escapeHtml(node.id)}">
        <span class="nexus-cluster-popup-dot" style="background:${cat.color};box-shadow:0 0 6px ${cat.color}"></span>
        <span class="nexus-cluster-popup-body">
          <span class="nexus-cluster-popup-title">${escapeHtml(node.name)}</span>
          <span class="nexus-cluster-popup-meta">${escapeHtml([cat.label, date].filter(Boolean).join(' · '))}</span>
        </span>
      </button>`
    })
    .join('')

  return `<div class="nexus-cluster-popup">
    <header class="nexus-cluster-popup-header">
      <h3 class="nexus-cluster-popup-heading">Choose a notice</h3>
      ${placeLine}
    </header>
    <div class="nexus-cluster-popup-list">${items}</div>
  </div>`
}
