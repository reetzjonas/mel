import { differenceInCalendarDays, isThisYear, isToday, isYesterday } from 'date-fns'
import { currentLocale } from './i18n'

const time = new Intl.DateTimeFormat(currentLocale, { hour: 'numeric', minute: '2-digit' })
const dayMonth = new Intl.DateTimeFormat(currentLocale, { day: 'numeric', month: 'short' })
const shortDate = new Intl.DateTimeFormat(currentLocale, { dateStyle: 'medium' })
const fullDate = new Intl.DateTimeFormat(currentLocale, {
  dateStyle: 'full',
  timeStyle: 'short',
})

export function formatListDate(value: number | string): string {
  const d = new Date(value)
  if (isToday(d)) return time.format(d)
  if (isThisYear(d)) return dayMonth.format(d)
  return shortDate.format(d)
}

export function formatFullDate(iso: string): string {
  return fullDate.format(new Date(iso))
}

export type DateBucket = 'today' | 'yesterday' | 'thisWeek' | 'older'

/**
 * Coarse bucket for grouping a date-sorted list. Returns a key rather than a
 * label so callers compare identity, not display copy — reworded translations
 * must not change where the group boundaries fall.
 */
export function dateBucket(value: number | string): DateBucket {
  const d = new Date(value)
  if (isToday(d)) return 'today'
  if (isYesterday(d)) return 'yesterday'
  if (differenceInCalendarDays(new Date(), d) < 7) return 'thisWeek'
  return 'older'
}

const relative = new Intl.RelativeTimeFormat(currentLocale, { numeric: 'auto' })

/** "just now" / "2 minutes ago" for a past timestamp. */
export function formatRelativePast(epochMs: number): string {
  const seconds = Math.round((epochMs - Date.now()) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 45) return relative.format(0, 'second')
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour')
  return relative.format(Math.round(seconds / 86400), 'day')
}
