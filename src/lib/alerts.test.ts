import { describe, expect, it } from 'vitest'
import type { CalendarEvent, EventAlerts } from '../domain/calendar'
import { pendingAlerts, reminderOf, toAlerts, withReminder } from './alerts'

const base: CalendarEvent = {
  id: 'e1',
  calendarIds: { c: true },
  uid: 'u1',
  title: 'Standup',
  description: '',
  location: 'Room 4',
  start: '2026-08-03T10:00:00',
  timeZone: 'Europe/Berlin',
  duration: 'PT1H',
  showWithoutTime: false,
  status: 'confirmed',
  recurrenceRule: null,
  recurrenceOverrides: {},
  participants: [],
  isOrganizerCopy: true,
}

const display = (offset: string, over: Record<string, unknown> = {}): EventAlerts => ({
  a1: {
    '@type': 'Alert',
    trigger: { '@type': 'OffsetTrigger', offset, relativeTo: 'start' },
    action: 'display',
    ...over,
  },
})

const at = (iso: string) => new Date(iso)
const ZONE = 'Europe/Berlin'
const DAY = 86_400_000

describe('reading the reminder the dialog offers', () => {
  it('reads minutes, hours and days before the start', () => {
    expect(reminderOf(display('-PT15M'))?.minutes).toBe(15)
    expect(reminderOf(display('-PT1H'))?.minutes).toBe(60)
    expect(reminderOf(display('-P1D'))?.minutes).toBe(1440)
    expect(reminderOf(display('PT0S'))?.minutes).toBe(0)
  })

  it('does not offer what it cannot round-trip', () => {
    expect(reminderOf(display('PT10M'))).toBeNull() // after the start
    expect(reminderOf(display('-PT30S'))).toBeNull() // seconds
    expect(reminderOf(display('-PT15M', { action: 'email' }))).toBeNull()
    expect(
      reminderOf({ a: { trigger: { '@type': 'AbsoluteTrigger', when: '2026-08-03T08:00:00Z' } } }),
    ).toBeNull()
    expect(
      reminderOf({ a: { trigger: { offset: '-PT5M', relativeTo: 'end' }, action: 'display' } }),
    ).toBeNull()
    expect(reminderOf({ a: { trigger: { offset: 'nonsense' } } })).toBeNull()
  })

  it('takes an alert with no action to be a display alert, as the RFC does', () => {
    expect(reminderOf({ a: { trigger: { offset: '-PT5M' } } })?.minutes).toBe(5)
  })
})

describe('changing the reminder', () => {
  it('replaces the one it manages under the same key', () => {
    const next = withReminder(display('-PT15M'), 60)
    expect(Object.keys(next)).toEqual(['a1'])
    expect(reminderOf(next)?.minutes).toBe(60)
  })

  it('adds one when there was none, and removes it for null', () => {
    const added = withReminder({}, 10)
    expect(reminderOf(added)?.minutes).toBe(10)
    expect(withReminder(added, null)).toEqual({})
  })

  it('writes "at the start" as a zero offset', () => {
    const trigger = withReminder({}, 0)['mel-reminder']!['trigger'] as { offset: string }
    expect(trigger.offset).toBe('PT0S')
  })

  it('leaves alerts it does not manage exactly as they were', () => {
    const foreign: EventAlerts = {
      mail: { action: 'email', trigger: { offset: '-P1D' }, custom: 1 },
      abs: { trigger: { '@type': 'AbsoluteTrigger', when: '2026-08-03T08:00:00Z' } },
    }
    const next = withReminder(foreign, 5)
    expect(next['mail']).toBe(foreign['mail'])
    expect(next['abs']).toBe(foreign['abs'])
    expect(withReminder(next, null)).toEqual(foreign)
  })
})

describe('toAlerts', () => {
  it('keeps objects and drops everything else', () => {
    expect(toAlerts({ a: { x: 1 }, b: 'no', c: null, d: [1] })).toEqual({ a: { x: 1 } })
    expect(toAlerts(null)).toEqual({})
    expect(toAlerts('x')).toEqual({})
  })
})

describe('which alerts are due', () => {
  const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({ ...base, ...over })

  it('finds an alert that falls due within the horizon', () => {
    // 10:00 Berlin (CEST) is 08:00Z; 15 minutes before is 07:45Z.
    const [a] = pendingAlerts(
      [ev({ alerts: display('-PT15M') })],
      at('2026-08-03T07:00:00Z'),
      DAY,
      ZONE,
    )
    expect(a?.fireAt.toISOString()).toBe('2026-08-03T07:45:00.000Z')
    expect(a).toMatchObject({ title: 'Standup', location: 'Room 4', eventId: 'e1' })
  })

  it('ignores an alert beyond the horizon', () => {
    const now = at('2026-08-01T00:00:00Z')
    expect(pendingAlerts([ev({ alerts: display('-PT15M') })], now, 3_600_000, ZONE)).toEqual([])
  })

  it('still reports one whose moment passed while the app was closed', () => {
    const late = at('2026-08-03T07:50:00Z') // 5 minutes after the alert, 10 before the start
    expect(pendingAlerts([ev({ alerts: display('-PT15M') })], late, 0, ZONE)).toHaveLength(1)
  })

  it('drops one whose event is already over', () => {
    const after = at('2026-08-03T09:30:00Z') // the hour ended at 09:00Z
    expect(pendingAlerts([ev({ alerts: display('-PT15M') })], after, 0, ZONE)).toEqual([])
  })

  it('skips cancelled events, email alerts and events without alerts', () => {
    const now = at('2026-08-03T07:00:00Z')
    expect(
      pendingAlerts([ev({ alerts: display('-PT15M'), status: 'cancelled' })], now, DAY, ZONE),
    ).toEqual([])
    expect(
      pendingAlerts([ev({ alerts: display('-PT15M', { action: 'email' }) })], now, DAY, ZONE),
    ).toEqual([])
    expect(pendingAlerts([ev({})], now, DAY, ZONE)).toEqual([])
  })

  it('honours an alert another client already acknowledged', () => {
    const now = at('2026-08-03T07:50:00Z')
    const acked = display('-PT15M', { acknowledged: '2026-08-03T07:46:00Z' })
    expect(pendingAlerts([ev({ alerts: acked })], now, 0, ZONE)).toEqual([])
    // An acknowledgement from before this alert fell due is about an older one.
    const stale = display('-PT15M', { acknowledged: '2026-08-03T07:00:00Z' })
    expect(pendingAlerts([ev({ alerts: stale })], now, 0, ZONE)).toHaveLength(1)
  })

  it('supports an absolute trigger', () => {
    const alerts: EventAlerts = {
      a: { trigger: { '@type': 'AbsoluteTrigger', when: '2026-08-03T06:00:00Z' } },
    }
    const [a] = pendingAlerts([ev({ alerts })], at('2026-08-03T05:00:00Z'), DAY, ZONE)
    expect(a?.fireAt.toISOString()).toBe('2026-08-03T06:00:00.000Z')
  })

  it('supports a trigger relative to the end', () => {
    const alerts: EventAlerts = {
      a: { trigger: { offset: '-PT10M', relativeTo: 'end' }, action: 'display' },
    }
    const [a] = pendingAlerts([ev({ alerts })], at('2026-08-03T07:00:00Z'), DAY, ZONE)
    expect(a?.fireAt.toISOString()).toBe('2026-08-03T08:50:00.000Z')
  })

  it('fires once per occurrence of a series, each keyed differently', () => {
    const daily = ev({ alerts: display('-PT15M'), recurrenceRule: { frequency: 'daily' } })
    const found = pendingAlerts([daily], at('2026-08-03T07:00:00Z'), 3 * DAY, ZONE)
    expect(found.map((a) => a.fireAt.toISOString())).toEqual([
      '2026-08-03T07:45:00.000Z',
      '2026-08-04T07:45:00.000Z',
      '2026-08-05T07:45:00.000Z',
    ])
    expect(new Set(found.map((a) => a.key)).size).toBe(3)
  })

  it('shows a moved occurrence at its new time, under a new key', () => {
    const series = ev({
      alerts: display('-PT15M'),
      recurrenceRule: { frequency: 'daily' },
      recurrenceOverrides: {
        '2026-08-04T10:00:00': { start: '2026-08-04T14:00:00', title: 'Moved' },
      },
    })
    const found = pendingAlerts([series], at('2026-08-04T00:00:00Z'), DAY, ZONE)
    expect(found.map((a) => [a.title, a.fireAt.toISOString()])).toEqual([
      ['Moved', '2026-08-04T11:45:00.000Z'],
    ])
  })

  it('leaves out an occurrence that was deleted from the series', () => {
    const series = ev({
      alerts: display('-PT15M'),
      recurrenceRule: { frequency: 'daily' },
      recurrenceOverrides: { '2026-08-04T10:00:00': { excluded: true } },
    })
    const found = pendingAlerts([series], at('2026-08-03T07:00:00Z'), 3 * DAY, ZONE)
    expect(found.map((a) => a.fireAt.toISOString().slice(0, 10))).toEqual([
      '2026-08-03',
      '2026-08-05',
    ])
  })

  it('keeps a series at its wall-clock hour across a DST change', () => {
    // Europe/Berlin leaves summer time on 2026-10-25: 10:00 is 08:00Z before, 09:00Z after.
    const series = ev({
      start: '2026-10-24T10:00:00',
      alerts: display('-PT15M'),
      recurrenceRule: { frequency: 'daily' },
    })
    const found = pendingAlerts([series], at('2026-10-24T00:00:00Z'), 3 * DAY, ZONE)
    expect(found.map((a) => a.fireAt.toISOString())).toEqual([
      '2026-10-24T07:45:00.000Z',
      '2026-10-25T08:45:00.000Z',
      '2026-10-26T08:45:00.000Z',
    ])
  })

  it('counts "a day before" as a calendar day, not 24 hours, over a DST change', () => {
    // 10:00 on the 26th is 09:00Z (winter); the day before is the 25th, also after the change.
    // On the 25th itself the previous day is still summer: 10:00 CEST = 08:00Z the 24th.
    const e = ev({ start: '2026-10-25T10:00:00', alerts: display('-P1D') })
    const [a] = pendingAlerts([e], at('2026-10-20T00:00:00Z'), 10 * DAY, ZONE)
    expect(a?.fireAt.toISOString()).toBe('2026-10-24T08:00:00.000Z')
  })

  it('places an all-day event in the viewer’s zone', () => {
    const e = ev({
      start: '2026-08-03T00:00:00',
      showWithoutTime: true,
      timeZone: null,
      duration: 'P1D',
      alerts: display('-PT9H'),
    })
    const [a] = pendingAlerts([e], at('2026-08-02T00:00:00Z'), 2 * DAY, 'America/New_York')
    // Midnight in New York (EDT) is 04:00Z; nine hours before is 19:00Z the day before.
    expect(a?.fireAt.toISOString()).toBe('2026-08-02T19:00:00.000Z')
  })

  it('reads events synced before alerts were kept', () => {
    const old = { ...base } as CalendarEvent
    delete (old as { alerts?: unknown }).alerts
    expect(pendingAlerts([old], at('2026-08-03T07:00:00Z'), DAY, ZONE)).toEqual([])
  })
})
