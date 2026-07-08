/** Shared date parsing for the Nexus timeline (ISO dates from pipeline output). */

export const YEAR_FLOOR = 1600
export const YEAR_CEIL = 1900

/** Show month drill-down when a year has at least this many dated events. */
export const MONTH_PICKER_THRESHOLD = 12

export type ParsedRecordDate = {
  year: number
  month: number | null
  day: number | null
  /** ISO YYYY-MM-DD when month and day are known. */
  iso: string | null
}

const MONTH_SHORT_SV = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'Maj',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Okt',
  'Nov',
  'Dec',
] as const

export function parseRecordDate(raw: unknown): ParsedRecordDate | null {
  if (raw == null || raw === '') return null
  const text = String(raw).trim()

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) {
    const year = Number(iso[1])
    const month = Number(iso[2])
    const day = Number(iso[3])
    if (
      year >= YEAR_FLOOR &&
      year <= YEAR_CEIL &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      return { year, month, day, iso: `${iso[1]}-${iso[2]}-${iso[3]}` }
    }
  }

  const yearOnly = text.match(/^(\d{4})\b/)
  if (yearOnly) {
    const year = Number(yearOnly[1])
    if (year >= YEAR_FLOOR && year <= YEAR_CEIL) {
      return { year, month: null, day: null, iso: null }
    }
  }

  return null
}

export function monthLabel(month: number, locale = 'sv-SE'): string {
  const d = new Date(Date.UTC(2000, month - 1, 1))
  return d.toLocaleDateString(locale, { month: 'long' })
}

export function monthShort(month: number): string {
  return MONTH_SHORT_SV[month - 1] ?? String(month)
}

export function formatEventDate(iso: string | null | undefined, fallbackYear?: number): string {
  if (iso) {
    const [y, m, d] = iso.split('-').map(Number)
    if (m && d) {
      return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('sv-SE', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    }
  }
  return fallbackYear != null ? String(fallbackYear) : ''
}

export function monthFromIso(iso: string | null | undefined): number | null {
  if (!iso || iso.length < 7) return null
  const month = Number(iso.slice(5, 7))
  return month >= 1 && month <= 12 ? month : null
}

export function shouldShowMonthPicker(
  yearCount: number,
  monthCounts: Record<number, number> | undefined,
): boolean {
  const distinctMonths = monthCounts ? Object.keys(monthCounts).length : 0
  return yearCount >= MONTH_PICKER_THRESHOLD || distinctMonths >= 2
}
