import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../domain/calendar'
import { expandOccurrences } from './recurrence'

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
}

const win = (fromIso: string, toIso: string) =>
  [new Date(fromIso), new Date(toIso)] as const

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

    const until = { ...base, recurrenceRule: { ...base.recurrenceRule!, until: '2026-03-31T00:00:00' } }
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
