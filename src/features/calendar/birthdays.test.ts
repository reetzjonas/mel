import { describe, expect, it } from 'vitest'
import { emptyContact, type Contact } from '../../domain/contact'
import { expandAll } from '../../lib/recurrence'
import {
  birthdayEvents,
  contactIdOfBirthday,
  isBirthdayEventId,
  BIRTHDAY_CALENDAR_ID,
} from './birthdays'

const contact = (over: Partial<Contact>): Contact => ({ ...emptyContact('b'), ...over })

const erika = contact({ id: 'c1', given: 'Erika', surname: 'Mustermann', birthday: '1985-04-20' })
const noYear = contact({ id: 'c2', given: 'Ines', birthday: '--02-29' })

describe('deriving a birthday entry', () => {
  it('makes one all-day yearly event per contact that has a birthday', () => {
    const events = birthdayEvents(
      [erika, contact({ id: 'c3', given: 'Nobody' })],
      new Date(2026, 0, 1),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.showWithoutTime).toBe(true)
    expect(events[0]?.recurrenceRule).toEqual({ frequency: 'yearly' })
    expect(events[0]?.title).toContain('Erika Mustermann')
  })

  // The series only has to cover what is on screen; anchoring it at the year of
  // birth would make every expansion walk the decades in between.
  it('anchors just before the window rather than at the year of birth', () => {
    const events = birthdayEvents([erika], new Date(2026, 0, 1))
    expect(events[0]?.start.startsWith('2025-04-20')).toBe(true)
  })

  it('belongs to a calendar that exists only here, so it can be switched off', () => {
    // Nothing on the server carries this id; it is what gives the sidebar a
    // row to offer and the events a colour of their own.
    expect(birthdayEvents([erika], new Date(2026, 0, 1))[0]?.calendarIds).toEqual({
      [BIRTHDAY_CALENDAR_ID]: true,
    })
  })

  it('carries the contact in its id, both ways', () => {
    const id = birthdayEvents([erika], new Date(2026, 0, 1))[0]!.id
    expect(isBirthdayEventId(id)).toBe(true)
    expect(contactIdOfBirthday(id)).toBe('c1')
    expect(isBirthdayEventId('abc')).toBe(false)
  })
})

describe('the entry as the calendar expands it', () => {
  it('lands on the birthday in the year on screen', () => {
    const events = birthdayEvents([erika], new Date(2026, 3, 1))
    const occurrences = expandAll(
      events,
      new Date(2026, 3, 1),
      new Date(2026, 4, 1),
      'Europe/Berlin',
    )
    expect(occurrences).toHaveLength(1)
    expect(occurrences[0]?.allDay).toBe(true)
    expect(occurrences[0]?.start.getFullYear()).toBe(2026)
    expect(occurrences[0]?.start.getMonth()).toBe(3)
  })

  it('does not appear in a month it does not fall in', () => {
    const events = birthdayEvents([erika], new Date(2026, 4, 1))
    expect(expandAll(events, new Date(2026, 4, 1), new Date(2026, 5, 1), 'Europe/Berlin')).toEqual(
      [],
    )
  })

  // 29 February only exists every fourth year, and a birthday on it must not
  // silently become 1 March in the years between.
  it('skips a leap day in a year that has none', () => {
    const events = birthdayEvents([noYear], new Date(2026, 0, 1))
    const march = expandAll(events, new Date(2026, 2, 1), new Date(2026, 2, 8), 'Europe/Berlin')
    expect(march).toEqual([])
  })
})
