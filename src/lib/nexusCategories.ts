/**
 * Category system for nexus records: every node gets one specific category,
 * derived from structured extraction fields (crime, fire_cause, parish_event,
 * themes) with keyword fallbacks on the Swedish label/description text.
 * Categories drive color coding across the map, mindmap, ledger and filters.
 */

export type CategoryId =
  | 'crime'
  | 'fire'
  | 'court'
  | 'conspiracy'
  | 'church'
  | 'commerce'
  | 'foreign'
  | 'daily'
  | 'person'
  | 'place'

export type NexusCategory = {
  id: CategoryId
  label: string
  color: string
  description: string
}

export const NEXUS_CATEGORIES: NexusCategory[] = [
  { id: 'crime', label: 'Crime & Justice', color: '#ef4444', description: 'Thefts, assaults, trials, punishments' },
  { id: 'fire', label: 'Fires & Accidents', color: '#f97316', description: 'Fires, drownings, misfortunes' },
  { id: 'court', label: 'Court & State', color: '#eab308', description: 'Royalty, government, official notices' },
  { id: 'conspiracy', label: 'Conspiracy', color: '#ec4899', description: 'Plots, treason, unrest' },
  { id: 'church', label: 'Church & Parish', color: '#2dd4bf', description: 'Clergy, sermons, births, deaths, weddings' },
  { id: 'commerce', label: 'Trade & Notices', color: '#22c55e', description: 'Auctions, sales, shipping, prices' },
  { id: 'foreign', label: 'Foreign Dispatches', color: '#38bdf8', description: 'News from abroad printed in Stockholm' },
  { id: 'daily', label: 'City Life', color: '#a78bfa', description: 'Everyday reports from Gamla Stan' },
  { id: 'person', label: 'People', color: '#e2e8f0', description: 'Named residents and officials' },
  { id: 'place', label: 'Places', color: '#a3e635', description: 'Buildings, quarters, landmarks' },
]

const CATEGORY_BY_ID = new Map(NEXUS_CATEGORIES.map((c) => [c.id, c]))

const FALLBACK_CATEGORY: NexusCategory = CATEGORY_BY_ID.get('daily')!

export function categoryById(id: string | undefined | null): NexusCategory {
  return (id && CATEGORY_BY_ID.get(id as CategoryId)) || FALLBACK_CATEGORY
}

export function categoryColor(id: string | undefined | null): string {
  return categoryById(id).color
}

// --- classification -------------------------------------------------------

/**
 * Keyword regex anchored at the start of a word (Unicode-aware), so short
 * roots like "rån" don't match inside "från" or "elden" inside "Seldener".
 * Suffixes stay open to allow Swedish inflections ("stöld" -> "stölder").
 */
function keywords(roots: string[]): RegExp {
  return new RegExp(`(?<!\\p{L})(?:${roots.join('|')})`, 'u')
}

const FOREIGN_PLACES = keywords([
  'paris', 'london', 'madrid', 'wien', 'konstantinopel', 'petersburg', 'berlin',
  'köpenhamn', 'kiöpenhamn', 'amsterdam', 'neapel', 'lissabon', 'hamburg', 'egypten',
  'warschau', 'warszawa', 'bryssel', 'brüssel', 'genua', 'venedig', 'cadiz',
  'gibraltar', 'algier', 'botany bay', 'amerika', 'america', 'frankrike', 'england',
  'spanien', 'portugal', 'holland', 'ryssland', 'turkiet', 'italien', 'preussen',
  'polen', 'danmark',
])

const CRIME_WORDS = keywords([
  'stöld', 'stulit', 'stulna', 'tjuf', 'tjuv', 'snatteri', 'rån', 'mord', 'dråp',
  'mörda', 'inbrott', 'häkt', 'arrester', 'fängelse', 'fängslig', 'rättegång',
  'ransak', 'dömd', 'dömdes', 'straff', 'afrätt', 'avrätt', 'bödel', 'brottsling',
  'bedräger', 'förfalsk', 'misshandel', 'slagsmål', 'polis', 'efterlys',
])

const FIRE_WORDS = keywords([
  'brand', 'eldsvåda', 'vådeld', 'brunnit', 'nedbrunn', 'elden', 'lågor',
  'drunkna', 'omkom', 'olycka', 'olyckshändelse',
])

const CONSPIRACY_WORDS = keywords([
  'sammansvärjning', 'konspiration', 'förräderi', 'förrädare', 'uppror', 'revolt',
  'myteri', 'kuppförsök', 'anslag mot',
])

const COURT_WORDS = keywords([
  'kungl', 'konung', 'kungen', 'kungan', 'hovet', 'hofvet', 'majestät', 'riksdag',
  'slottet', 'hertig', 'prins', 'prinsessa', 'drottning', 'regering', 'ständer',
  'rådet', 'kansli', 'förordning', 'kungörelse',
])

const CHURCH_WORDS = keywords([
  // 'kyrka'/'kyrkan' (not bare 'kyrk') so street names like Kyrkobrinken don't match
  'kyrka', 'kyrkan', 'präst(?!gatan)', 'pastor', 'församling', 'begravning', 'begrafning',
  'jordfäst', 'döpt', 'dop', 'vigsel', 'vigd', 'brudpar', 'gudstjänst', 'predik',
  'biskop', 'klockare', 'storkyrk', 'dödsfall', 'avliden', 'afliden', 'avlidit',
])

const COMMERCE_WORDS = keywords([
  'auktion', 'auction', 'til salu', 'till salu', 'försälj', 'utbjud', 'salubjud',
  'handel', 'handlande', 'köpman', 'skepp', 'fartyg', 'frakt', 'inkommit',
  'inlupit', 'ankommit', 'priser', 'taxa', 'vexelkurs', 'växelkurs',
  'bokutgivning', 'utgifwen', 'prenumeration', 'uthyr', 'uthynes', 'varuannons',
])

type Meta = Record<string, unknown>

function metaString(meta: Meta, key: string): string | null {
  const v = meta[key]
  if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  return null
}

function metaThemes(meta: Meta, inner: Meta): string[] {
  for (const source of [meta.themes, inner.themes]) {
    if (Array.isArray(source)) return source.filter((t): t is string => typeof t === 'string')
  }
  return []
}

/**
 * Classify a master-graph node into one category.
 * Structured fields win over keyword matches; foreign news is checked first so
 * that e.g. a murder in Paris reads as a foreign dispatch, not a local crime.
 */
export function categorizeNode(
  kind: 'person' | 'place' | 'event',
  name: string,
  metadata?: Record<string, unknown>,
): CategoryId {
  if (kind === 'person') return 'person'
  if (kind === 'place') return 'place'

  const meta: Meta = metadata ?? {}
  const inner: Meta = (meta.metadata as Meta | undefined) ?? {}

  // Records from the extraction pipelines carry an explicit category; trust it.
  const explicit = metaString(inner, 'category') ?? metaString(meta, 'category')
  if (explicit && CATEGORY_BY_ID.has(explicit as CategoryId)) return explicit as CategoryId

  const themes = metaThemes(meta, inner)
  const text = `${name} ${metaString(meta, 'description') ?? ''}`.toLowerCase()

  // Foreign dispatches: mention a foreign place AND have no specific local
  // address (they land on the district-center fallback pin).
  const address = (metaString(meta, 'address') ?? '').toLowerCase()
  const noLocalAddress =
    address === '' ||
    address === 'gamla stan' ||
    metaString(inner, 'geocode_status') === 'district_fallback' ||
    inner.location_approximate === true
  if (noLocalAddress && FOREIGN_PLACES.test(text)) return 'foreign'
  if (metaString(inner, 'fire_cause') || FIRE_WORDS.test(text)) return 'fire'
  if (metaString(inner, 'crime') || CRIME_WORDS.test(text)) return 'crime'
  if (themes.includes('Conspiracy') || CONSPIRACY_WORDS.test(text)) return 'conspiracy'
  if (metaString(inner, 'parish_event') || CHURCH_WORDS.test(text)) return 'church'
  if (themes.includes('Court & State') || COURT_WORDS.test(text)) return 'court'
  if (COMMERCE_WORDS.test(text)) return 'commerce'
  if (themes.includes('Security Threats')) return 'crime'
  return 'daily'
}
