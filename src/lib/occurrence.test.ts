import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../domain/calendar'
import {
  isExcluded,
  occurrenceEvent,
  patchFor,
  seriesFromOccurrence,
  withoutOccurrence,
} from './occurrence'

const series: CalendarEvent = {
  id: 'e1',
  calendarIds: { c: true },
  uid: 'u1',
  title: 'Standup',
  description: 'Every Monday',
  location: 'Room 1',
  start: '2026-10-05T10:00:00',
  timeZone: 'Europe/Berlin',
  duration: 'PT1H',
  showWithoutTime: false,
  status: 'confirmed',
  recurrenceRule: { frequency: 'weekly', byDay: ['mo'] },
  recurrenceOverrides: {},
  participants: [],
  isOrganizerCopy: true,
}

describe('occurrenceEvent', () => {
  it('reads an untouched occurrence as the series at that date', () => {
    const occ = occurrenceEvent(series, '2026-10-12T10:00:00')

    expect(occ.start).toBe('2026-10-12T10:00:00')
    expect(occ.title).toBe('Standup')
    expect(occ.duration).toBe('PT1H')
  })

  it('applies what the patch changes and nothing else', () => {
    const event = {
      ...series,
      recurrenceOverrides: {
        '2026-10-12T10:00:00': { start: '2026-10-12T14:00:00', title: 'Moved once' },
      },
    }
    const occ = occurrenceEvent(event, '2026-10-12T10:00:00')

    expect(occ.start).toBe('2026-10-12T14:00:00')
    expect(occ.title).toBe('Moved once')
    expect(occ.description).toBe('Every Monday')
    expect(occ.location).toBe('Room 1')
  })

  it('reads a location written either way round', () => {
    const asObject = {
      ...series,
      recurrenceOverrides: { '2026-10-12T10:00:00': { locations: { l0: { name: 'Room 9' } } } },
    }
    const asPointer = {
      ...series,
      recurrenceOverrides: { '2026-10-12T10:00:00': { 'locations/l0/name': 'Room 9' } },
    }

    expect(occurrenceEvent(asObject, '2026-10-12T10:00:00').location).toBe('Room 9')
    expect(occurrenceEvent(asPointer, '2026-10-12T10:00:00').location).toBe('Room 9')
  })

  it('ignores a value of the wrong type rather than putting it in the event', () => {
    // The patch comes off the wire; a number where a title belongs is not a
    // title, and the series' own value is the honest answer.
    const event = {
      ...series,
      recurrenceOverrides: { '2026-10-12T10:00:00': { title: 42, status: 'nonsense' } },
    }
    const occ = occurrenceEvent(event, '2026-10-12T10:00:00')

    expect(occ.title).toBe('Standup')
    expect(occ.status).toBe('confirmed')
  })
})

describe('patchFor', () => {
  const rid = '2026-10-12T10:00:00'

  it('writes only what differs from the series', () => {
    const edited = { ...occurrenceEvent(series, rid), start: '2026-10-12T14:00:00' }

    expect(patchFor(series, rid, edited)).toEqual({ start: '2026-10-12T14:00:00' })
  })

  it('leaves nothing behind when an occurrence is put back as it was', () => {
    const event = { ...series, recurrenceOverrides: { [rid]: { title: 'Moved once' } } }
    const edited = occurrenceEvent(series, rid)

    expect(patchFor(event, rid, edited)).toEqual({})
  })

  it('keeps fields of the existing patch that mel does not offer', () => {
    // Another client's work, and the server's own stamp: rewriting the whole
    // map must not be how they get deleted.
    const event = {
      ...series,
      recurrenceOverrides: { [rid]: { updated: '2026-09-17T12:00:00Z', color: 'red' } },
    }
    const edited = { ...occurrenceEvent(series, rid), title: 'Renamed' }

    expect(patchFor(event, rid, edited)).toEqual({
      updated: '2026-09-17T12:00:00Z',
      color: 'red',
      title: 'Renamed',
    })
  })

  it('replaces a location written as a pointer rather than leaving both', () => {
    const event = { ...series, recurrenceOverrides: { [rid]: { 'locations/l0/name': 'Room 9' } } }
    const edited = { ...occurrenceEvent(series, rid), location: 'Room 12' }

    expect(patchFor(event, rid, edited)).toEqual({
      locations: { l0: { '@type': 'Location', name: 'Room 12' } },
    })
  })
})

describe('withoutOccurrence', () => {
  it('marks the occurrence excluded and leaves the series alone', () => {
    const next = withoutOccurrence(series, '2026-10-12T10:00:00')

    expect(isExcluded(next.recurrenceOverrides['2026-10-12T10:00:00'])).toBe(true)
    expect(next.start).toBe(series.start)
    expect(next.recurrenceRule).toEqual(series.recurrenceRule)
  })
})

describe('seriesFromOccurrence', () => {
  const rid = '2026-10-12T10:00:00'

  it('moves the series start by the days the occurrence moved', () => {
    // Not to the occurrence's own date: that would drop every earlier one.
    const edited = { ...occurrenceEvent(series, rid), start: '2026-10-13T11:00:00' }
    const next = seriesFromOccurrence(series, rid, edited)

    expect(next.start).toBe('2026-10-06T11:00:00')
  })

  it('follows the new weekday when the rule names one', () => {
    // Without this, "all events" on a Monday rule dragged to Tuesday would
    // appear to do nothing: the rule would go on producing Mondays.
    const edited = { ...occurrenceEvent(series, rid), start: '2026-10-13T10:00:00' }

    expect(seriesFromOccurrence(series, rid, edited).recurrenceRule?.byDay).toEqual(['tu'])
  })

  it('keeps the rule’s days when only the time changed', () => {
    const edited = { ...occurrenceEvent(series, rid), start: '2026-10-12T16:00:00' }
    const next = seriesFromOccurrence(series, rid, edited)

    expect(next.recurrenceRule?.byDay).toEqual(['mo'])
    expect(next.start).toBe('2026-10-05T16:00:00')
  })

  it('drops this occurrence’s own patch, which would otherwise outvote the edit', () => {
    const event = { ...series, recurrenceOverrides: { [rid]: { title: 'Special' } } }
    const edited = { ...occurrenceEvent(event, rid), title: 'Renamed' }
    const next = seriesFromOccurrence(event, rid, edited)

    expect(next.title).toBe('Renamed')
    expect(next.recurrenceOverrides).toEqual({})
  })

  it('leaves other occurrences’ patches where they are', () => {
    const other = '2026-10-19T10:00:00'
    const event = { ...series, recurrenceOverrides: { [other]: { title: 'Special' } } }
    const edited = { ...occurrenceEvent(event, rid), title: 'Renamed' }

    expect(seriesFromOccurrence(event, rid, edited).recurrenceOverrides).toEqual({
      [other]: { title: 'Special' },
    })
  })
})
