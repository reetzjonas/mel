import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dateBucket } from './dates'

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
