import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../domain/calendar'
import { expandAll, expandOccurrences, parseDuration } from './recurrence'

const base: CalendarEvent = {
  id: 'e1',
  calendarIds: { c: true },
  uid: 'u1',
  title: 'Weekly',
  description: '',
  location: '',
  start: '2026-03-23T10:00:00', // Monday before EU DST switch (2026-03-29)
  timeZone: 'Europe/Berlin',
  duration: 'PT1H',
  showWithoutTime: false,
  status: 'confirmed',
  recurrenceRule: { frequency: 'weekly', byDay: ['mo'] },
  participants: [],
  isOrganizerCopy: true,
}

const win = (fromIso: string, toIso: string) => [new Date(fromIso), new Date(toIso)] as const

describe('expandOccurrences', () => {
  it('keeps wall-clock time across the DST transition (Europe/Berlin)', () => {
    const [from, to] = win('2026-03-20T00:00:00Z', '2026-04-10T00:00:00Z')
    const occ = expandOccurrences(base, from, to, 'Europe/Berlin')
    expect(occ).toHaveLength(3) // Mar 23 (CET), Mar 30 + Apr 6 (CEST)
    // CET: 10:00 local = 09:00Z; CEST: 10:00 local = 08:00Z
    expect(occ[0]!.start.toISOString()).toBe('2026-03-23T09:00:00.000Z')
    expect(occ[1]!.start.toISOString()).toBe('2026-03-30T08:00:00.000Z')
    expect(occ[2]!.start.toISOString()).toBe('2026-04-06T08:00:00.000Z')
  })

  it('handles single events and window clipping', () => {
    const single = { ...base, recurrenceRule: null }
    const [from, to] = win('2026-03-23T00:00:00Z', '2026-03-24T00:00:00Z')
    expect(expandOccurrences(single, from, to, 'Europe/Berlin')).toHaveLength(1)
    const [f2, t2] = win('2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z')
    expect(expandOccurrences(single, f2, t2, 'Europe/Berlin')).toHaveLength(0)
  })

  it('respects count and until', () => {
    const counted = { ...base, recurrenceRule: { ...base.recurrenceRule!, count: 2 } }
    const [from, to] = win('2026-03-01T00:00:00Z', '2026-06-01T00:00:00Z')
    expect(expandOccurrences(counted, from, to, 'Europe/Berlin')).toHaveLength(2)

    const until = {
      ...base,
      recurrenceRule: { ...base.recurrenceRule!, until: '2026-03-31T00:00:00' },
    }
    expect(expandOccurrences(until, from, to, 'Europe/Berlin')).toHaveLength(2)
  })

  it('expands all-day events in the viewer zone', () => {
    const allDay: CalendarEvent = {
      ...base,
      start: '2026-08-01T00:00:00',
      timeZone: null,
      duration: 'P1D',
      showWithoutTime: true,
      recurrenceRule: null,
    }
    const [from, to] = win('2026-07-31T00:00:00Z', '2026-08-02T00:00:00Z')
    const occ = expandOccurrences(allDay, from, to, 'Europe/Berlin')
    expect(occ).toHaveLength(1)
    expect(occ[0]!.allDay).toBe(true)
  })
})

describe('parseDuration', () => {
  it('reads the ISO durations events actually carry', () => {
    expect(parseDuration('PT1H').total({ unit: 'minutes' })).toBe(60)
    expect(parseDuration('PT30M').total({ unit: 'minutes' })).toBe(30)
    expect(parseDuration('P1D').total({ unit: 'hours' })).toBe(24)
  })

  it('treats a missing duration as none, not as an error', () => {
    // A server may leave it out entirely; an event of unknown length would
    // otherwise take the whole grid down with it.
    expect(parseDuration('').total({ unit: 'seconds' })).toBe(0)
  })

  it('falls back to zero on something it cannot read', () => {
    // One malformed event must not empty the calendar around it.
    expect(parseDuration('not-a-duration').total({ unit: 'seconds' })).toBe(0)
    expect(parseDuration('P1X').total({ unit: 'seconds' })).toBe(0)
  })
})

describe('expandAll', () => {
  const single = (over: Partial<CalendarEvent>): CalendarEvent => ({
    ...base,
    recurrenceRule: null,
    ...over,
  })

  it('returns everything in the window in time order, whatever order it was given', () => {
    // The day and week grids render straight from this list.
    const out = expandAll(
      [
        single({ id: 'late', start: '2026-03-23T15:00:00' }),
        single({ id: 'early', start: '2026-03-23T08:00:00' }),
      ],
      ...win('2026-03-23T00:00:00Z', '2026-03-24T00:00:00Z'),
      'Europe/Berlin',
    )
    expect(out.map((o) => o.eventId)).toEqual(['early', 'late'])
  })

  it('leaves a cancelled event out entirely', () => {
    /*
     * A cancelled invitation stays in the store — the reply and the history
     * belong to it — but it is not something happening, and drawing it would
     * put a meeting on the grid that was called off.
     */
    const out = expandAll(
      [single({ id: 'off', status: 'cancelled' }), single({ id: 'on' })],
      ...win('2026-03-23T00:00:00Z', '2026-03-24T00:00:00Z'),
      'Europe/Berlin',
    )
    expect(out.map((o) => o.eventId)).toEqual(['on'])
  })

  it('is empty for a window nothing falls into', () => {
    const out = expandAll(
      [single({})],
      ...win('2027-01-01T00:00:00Z', '2027-01-02T00:00:00Z'),
      'Europe/Berlin',
    )
    expect(out).toEqual([])
  })

  it('interleaves a series with single events by time', () => {
    const out = expandAll(
      [base, single({ id: 'one-off', start: '2026-03-30T09:00:00' })],
      ...win('2026-03-23T00:00:00Z', '2026-04-01T00:00:00Z'),
      'Europe/Berlin',
    )
    const times = out.map((o) => o.start.getTime())
    expect([...times]).toEqual([...times].sort((a, b) => a - b))
    expect(out.map((o) => o.eventId)).toContain('one-off')
  })
})
