import { describe, expect, it } from 'vitest'
import type { CalendarEvent, Participant } from '../../domain/calendar'
import { fromEvent, toEvent, type JmapCalendarEvent } from './calendars'

const base: JmapCalendarEvent = {
  id: 'e1',
  calendarIds: { b: true },
  uid: 'u1',
  title: 'Standup',
  start: '2026-09-10T10:00:00',
  timeZone: 'Europe/Berlin',
  duration: 'PT1H',
}

const attendee = (over: Partial<Participant> = {}): Participant => ({
  id: 'p2',
  email: 'bob@localhost',
  name: 'Bob',
  isOrganizer: false,
  required: true,
  status: 'needs-action',
  expectReply: true,
  ...over,
})

const organizer: Participant = {
  id: 'p1',
  email: 'alice@localhost',
  name: 'Alice',
  isOrganizer: true,
  required: true,
  status: 'accepted',
  expectReply: false,
}

const domainEvent = (participants: Participant[]): CalendarEvent => ({
  id: 'e1',
  calendarIds: { b: true },
  uid: 'u1',
  title: 'Standup',
  description: '',
  location: '',
  start: '2026-09-10T10:00:00',
  timeZone: 'Europe/Berlin',
  duration: 'PT1H',
  showWithoutTime: false,
  status: 'confirmed',
  recurrenceRule: null,
  participants,
  isOrganizerCopy: true,
})

describe('participant mapping', () => {
  it('reads participants and strips the mailto: scheme', () => {
    const e = toEvent({
      ...base,
      participants: {
        p1: {
          name: 'Alice',
          calendarAddress: 'mailto:alice@localhost',
          roles: { owner: true, chair: true },
          participationStatus: 'accepted',
          expectReply: false,
        },
        p2: {
          name: 'Bob',
          calendarAddress: 'mailto:bob@localhost',
          roles: { required: true },
          participationStatus: 'needs-action',
          expectReply: true,
        },
      },
    })
    expect(e.participants).toEqual([organizer, attendee()])
  })

  it('treats the organizerCalendarAddress as the organizer when no owner role is set', () => {
    const e = toEvent({
      ...base,
      organizerCalendarAddress: 'mailto:alice@localhost',
      participants: {
        p1: { name: 'Alice', calendarAddress: 'mailto:Alice@localhost', roles: { chair: true } },
      },
    })
    expect(e.participants[0]!.isOrganizer).toBe(true)
  })

  it('maps the optional role and falls back to needs-action for unknown statuses', () => {
    const e = toEvent({
      ...base,
      participants: {
        p2: {
          calendarAddress: 'mailto:bob@localhost',
          roles: { optional: true },
          participationStatus: 'delegated',
        },
      },
    })
    expect(e.participants[0]!.required).toBe(false)
    expect(e.participants[0]!.status).toBe('needs-action')
  })

  it('skips participants without an address', () => {
    const e = toEvent({ ...base, participants: { p1: { name: 'Nobody' } } })
    expect(e.participants).toEqual([])
  })

  it('marks the attendee copy of an invitation as not ours', () => {
    expect(toEvent({ ...base, isOrigin: false }).isOrganizerCopy).toBe(false)
    // Stalwart omits isOrigin on events nobody else organizes.
    expect(toEvent(base).isOrganizerCopy).toBe(true)
  })

  it('writes the organizer both as a role and as organizerCalendarAddress', () => {
    // Without the address Stalwart keeps the participants but sends no
    // invitation, so both halves have to go out.
    const out = fromEvent(domainEvent([organizer, attendee()]))
    expect(out['organizerCalendarAddress']).toBe('mailto:alice@localhost')
    const parts = out['participants'] as Record<string, Record<string, unknown>>
    expect(parts['p1']!['roles']).toEqual({ owner: true, chair: true, required: true })
    expect(parts['p1']!['calendarAddress']).toBe('mailto:alice@localhost')
    expect(parts['p2']!['roles']).toEqual({ required: true })
    expect(parts['p2']!['participationStatus']).toBe('needs-action')
  })

  it('leaves participants and organizer off a plain event', () => {
    const out = fromEvent(domainEvent([]))
    expect(out['participants']).toBeUndefined()
    expect(out['organizerCalendarAddress']).toBeUndefined()
  })

  it('folds away the roleless organizer copy Stalwart adds back', () => {
    const e = toEvent({
      ...base,
      organizerCalendarAddress: 'mailto:alice@localhost',
      participants: {
        p1: {
          name: 'Alice',
          calendarAddress: 'mailto:alice@localhost',
          roles: { owner: true, chair: true },
          participationStatus: 'accepted',
          expectReply: false,
        },
        'eac86613-25b2-535c-9154-d30874be851f': {
          name: 'Alice',
          calendarAddress: 'mailto:alice@localhost',
        },
      },
    })
    expect(e.participants).toHaveLength(1)
    // The surviving entry must be the one with roles — RSVP patches address it.
    expect(e.participants[0]!.id).toBe('p1')
  })

  it('round-trips through the wire shape', () => {
    const wire = fromEvent(domainEvent([organizer, attendee()])) as unknown as JmapCalendarEvent
    expect(toEvent({ ...wire, id: 'e1' }).participants).toEqual([organizer, attendee()])
  })
})
