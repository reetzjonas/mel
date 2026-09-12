import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentLocale } from './i18n'
import { dateBucket, formatListDate, formatRelativePast } from './dates'

describe('dateBucket', () => {
  beforeEach(() => {
    // Wednesday, noon — mid-week, so "this week" has days on both sides.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-09T12:00:00'))
  })
  afterEach(() => vi.useRealTimers())

  it('buckets by calendar day, not by elapsed hours', () => {
    expect(dateBucket('2026-09-09T00:30:00')).toBe('today')
    // Under 24h earlier, but the day before: yesterday, not today.
    expect(dateBucket('2026-09-08T23:30:00')).toBe('yesterday')
  })

  it('buckets the days before that as this week', () => {
    expect(dateBucket('2026-09-04T08:00:00')).toBe('thisWeek')
  })

  it('draws the line at seven calendar days', () => {
    expect(dateBucket('2026-09-03T08:00:00')).toBe('thisWeek')
    expect(dateBucket('2026-09-02T08:00:00')).toBe('older')
  })

  it('buckets a much older message', () => {
    expect(dateBucket('2025-08-01T08:00:00')).toBe('older')
  })
})

/*
 * These assert which *unit* the helpers pick, never how the browser spells
 * it: the choice is ours and is a real decision, the wording belongs to ICU
 * and changes with it.
 */
describe('formatListDate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-09T12:00:00'))
  })
  afterEach(() => vi.useRealTimers())

  const clock = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(currentLocale, o)

  it('shows a time for today, so the list reads as "when today"', () => {
    const at = '2026-09-09T08:30:00'
    expect(formatListDate(at)).toBe(
      clock({ hour: 'numeric', minute: '2-digit' }).format(new Date(at)),
    )
  })

  it('drops the year within it, and keeps it once it matters', () => {
    const thisYear = '2026-03-02T08:30:00'
    expect(formatListDate(thisYear)).toBe(
      clock({ day: 'numeric', month: 'short' }).format(new Date(thisYear)),
    )
    const older = '2024-03-02T08:30:00'
    expect(formatListDate(older)).toBe(clock({ dateStyle: 'medium' }).format(new Date(older)))
  })

  it('takes epoch milliseconds as readily as an ISO string', () => {
    const at = new Date('2026-09-09T08:30:00')
    expect(formatListDate(at.getTime())).toBe(formatListDate(at.toISOString()))
  })
})

describe('formatRelativePast', () => {
  const now = new Date('2026-09-09T12:00:00').getTime()
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })
  afterEach(() => vi.useRealTimers())

  const rel = new Intl.RelativeTimeFormat(currentLocale, { numeric: 'auto' })
  const ago = (n: number, unit: Intl.RelativeTimeFormatUnit) => rel.format(n, unit)

  it('says "now" for the last three quarters of a minute', () => {
    // The sync bar leans on this: while pushing, "just now" is the honest
    // answer and a ticking second count would only read as noise.
    expect(formatRelativePast(now)).toBe(ago(0, 'second'))
    expect(formatRelativePast(now - 44_000)).toBe(ago(0, 'second'))
  })

  it('steps up a unit at each boundary rather than counting seconds forever', () => {
    expect(formatRelativePast(now - 46_000)).toBe(ago(-1, 'minute'))
    expect(formatRelativePast(now - 59 * 60_000)).toBe(ago(-59, 'minute'))
    expect(formatRelativePast(now - 61 * 60_000)).toBe(ago(-1, 'hour'))
    expect(formatRelativePast(now - 23 * 3_600_000)).toBe(ago(-23, 'hour'))
    expect(formatRelativePast(now - 25 * 3_600_000)).toBe(ago(-1, 'day'))
  })
})
