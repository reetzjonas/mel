import { describe, expect, it, vi } from 'vitest'
import type { Transport } from './client/transport'
import { createJmapCalendars } from './calendars'
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

describe('createJmapCalendars provider', () => {
  it('omits immutable uid from updateEvent patch', async () => {
    const capturedCalls: Array<{ name: string; args: Record<string, unknown> }> = []
    const transport: Transport = {
      fetchRaw: vi.fn(),
      request: async (req) => {
        const [name, args, callId] = req.methodCalls[0]!
        capturedCalls.push({ name, args: args as Record<string, unknown> })
        return {
          methodResponses: [[name, { updated: { e1: null } }, callId]],
          sessionState: 's',
        } as never
      },
    }

    const provider = createJmapCalendars(transport, 'acc1')
    const event = domainEvent([])
    const failure = await provider.updateEvent(event)

    expect(failure).toBeNull()
    expect(capturedCalls).toHaveLength(1)
    expect(capturedCalls[0]!.name).toBe('CalendarEvent/set')
    const updateMap = capturedCalls[0]!.args['update'] as Record<string, Record<string, unknown>>
    expect(updateMap['e1']).toBeDefined()
    expect(updateMap['e1']!['title']).toBe('Standup')
    // uid is immutable in RFC 8984 and must not be present in the update patch
    expect(updateMap['e1']!['uid']).toBeUndefined()
  })

  it('includes uid when creating an event', async () => {
    const capturedCalls: Array<{ name: string; args: Record<string, unknown> }> = []
    const transport: Transport = {
      fetchRaw: vi.fn(),
      request: async (req) => {
        const [name, args, callId] = req.methodCalls[0]!
        capturedCalls.push({ name, args: args as Record<string, unknown> })
        return {
          methodResponses: [[name, { created: { e0: { id: 'created-id' } } }, callId]],
          sessionState: 's',
        } as never
      },
    }

    const provider = createJmapCalendars(transport, 'acc1')
    const event = domainEvent([])
    const res = await provider.createEvent(event)

    expect(res.id).toBe('created-id')
    expect(res.failure).toBeNull()
    const createMap = capturedCalls[0]!.args['create'] as Record<string, Record<string, unknown>>
    expect(createMap['e0']!['uid']).toBe('u1')
  })
})

/** Records what was sent and answers with whatever a test supplies. */
function capturing(response: Record<string, unknown> = {}) {
  const sent: Array<Record<string, unknown>> = []
  const transport: Transport = {
    fetchRaw: vi.fn(),
    request: async (req) => {
      const [name, args, callId] = req.methodCalls[0]!
      sent.push(args as Record<string, unknown>)
      return { methodResponses: [[name, response, callId]], sessionState: 's' } as never
    },
  }
  return { provider: createJmapCalendars(transport, 'acc1'), sent }
}

/*
 * Every write carries sendSchedulingMessages, and each value is a decision
 * about mail leaving the building: too eager and the server invites people to
 * an event they were never part of, too shy and an invitation is stored where
 * nobody is told about it.
 */
describe('when the server is told to send invitations', () => {
  it('does so for an event that has participants', async () => {
    const { provider, sent } = capturing({ created: { e0: { id: 'new' } } })

    await provider.createEvent(domainEvent([organizer, attendee()]))

    expect(sent[0]!['sendSchedulingMessages']).toBe(true)
  })

  it('stays quiet for an event with nobody but its owner', async () => {
    // A private appointment: there is no one to invite, and a scheduling
    // message would be mail from nowhere.
    const { provider, sent } = capturing({ created: { e0: { id: 'new' } } })

    await provider.createEvent(domainEvent([]))

    expect(sent[0]!['sendSchedulingMessages']).toBe(false)
  })

  it('always does for a cancellation, so attendees hear it is off', async () => {
    // Deleting silently leaves the meeting in everyone else's calendar.
    const { provider, sent } = capturing({ destroyed: ['e1'] })

    await provider.destroyEvents(['e1'])

    expect(sent[0]!['sendSchedulingMessages']).toBe(true)
  })

  it('always does for a reply, which is the whole point of one', async () => {
    const { provider, sent } = capturing({ updated: { e1: null } })

    await provider.rsvp('e1', 'p2', 'accepted')

    expect(sent[0]!['sendSchedulingMessages']).toBe(true)
  })
})

describe('answering an invitation', () => {
  it('patches only the one participation status', async () => {
    /*
     * A patch rather than a whole-event update: sending the event back would
     * overwrite whatever the organiser changed in the meantime with the copy
     * this device happened to hold.
     */
    const { provider, sent } = capturing({ updated: { e1: null } })

    await provider.rsvp('e1', 'p2', 'declined')

    expect(sent[0]!['update']).toEqual({
      e1: { 'participants/p2/participationStatus': 'declined' },
    })
  })

  it('reports a refusal rather than pretending the reply went out', async () => {
    const { provider } = capturing({ notUpdated: { e1: { type: 'forbidden' } } })

    await expect(provider.rsvp('e1', 'p2', 'accepted')).resolves.toMatchObject({
      type: 'forbidden',
      permanent: true,
    })
  })
})

describe('failures from the calendar server', () => {
  it('tells a refusal that will not change from one worth retrying', async () => {
    const permanent = capturing({ notCreated: { e0: { type: 'invalidProperties' } } })
    await expect(permanent.provider.createEvent(domainEvent([]))).resolves.toMatchObject({
      id: null,
      failure: { permanent: true },
    })

    const transient = capturing({ notCreated: { e0: { type: 'serverFail' } } })
    await expect(transient.provider.createEvent(domainEvent([]))).resolves.toMatchObject({
      failure: { permanent: false },
    })
  })

  it('treats a create that says nothing as a failure', async () => {
    // Neither created nor notCreated: reporting success would lose the event
    // while the dialog closes as though it were saved.
    const { provider } = capturing({})

    await expect(provider.createEvent(domainEvent([]))).resolves.toMatchObject({ id: null })
  })

  it('is null when a destroy went through', async () => {
    const { provider } = capturing({ destroyed: ['e1'] })
    await expect(provider.destroyEvents(['e1'])).resolves.toBeNull()
  })
})
