import { birthdayMonthDay, displayName, type Contact } from '../../domain/contact'
import type { CalendarEvent } from '../../domain/calendar'
import { t } from '../../lib/i18n'

/*
 * Birthdays shown in the calendar, without becoming events on the server.
 *
 * They are built as ordinary CalendarEvent objects with a yearly rule and fed
 * through the same expandAll() as real ones, so the recurrence — and every
 * DST and leap-day lesson already paid for in lib/recurrence — applies here
 * unchanged rather than being reimplemented for one more list.
 *
 * Nothing is written: these exist for the length of a render. The id carries
 * the contact so a click can lead back to the card it came from.
 */

const PREFIX = 'birthday:'

export function isBirthdayEventId(id: string): boolean {
  return id.startsWith(PREFIX)
}

export function contactIdOfBirthday(eventId: string): string {
  return eventId.slice(PREFIX.length)
}

const pad = (n: number) => String(n).padStart(2, '0')

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

/**
 * A year the birthday actually exists in, walking back for 29 February.
 *
 * Anchoring a leap-day birthday in an ordinary year produces "2025-02-29",
 * which is not a date: it rolls forward to 1 March and the series then lands
 * on the wrong day every single year. From a real leap day, a yearly rule
 * recurs only in leap years, which is the honest answer.
 */
function anchorYearFor(year: number, month: number, day: number): number {
  if (month !== 2 || day !== 29) return year
  let candidate = year
  while (!isLeapYear(candidate)) candidate--
  return candidate
}

/**
 * One all-day yearly event per contact with a birthday.
 *
 * Anchored the year before the window rather than at the year of birth: the
 * series only has to cover what is on screen, and starting in 1947 would make
 * the expansion walk eighty years to reach it.
 */
export function birthdayEvents(contacts: Contact[], windowStart: Date): CalendarEvent[] {
  const out: CalendarEvent[] = []
  for (const contact of contacts) {
    const monthDay = birthdayMonthDay(contact.birthday)
    if (!monthDay) continue
    const anchorYear = anchorYearFor(windowStart.getFullYear() - 1, monthDay.month, monthDay.day)
    const name = displayName(contact)
    out.push({
      id: `${PREFIX}${contact.id}`,
      // No calendar: these belong to no collection, which is also what leaves
      // them the default colour rather than borrowing one.
      calendarIds: {},
      uid: `${PREFIX}${contact.id}`,
      // Name first: a month cell truncates, and the name is the half worth
      // keeping. The year is on the card, which this leads to anyway.
      title: `${name} · ${t('contacts.birthday')}`,
      description: '',
      location: '',
      start: `${anchorYear}-${pad(monthDay.month)}-${pad(monthDay.day)}T00:00:00`,
      timeZone: null,
      duration: 'P1D',
      showWithoutTime: true,
      status: 'confirmed',
      recurrenceRule: { frequency: 'yearly' },
      participants: [],
      isOrganizerCopy: false,
    })
  }
  return out
}
