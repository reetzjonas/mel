import { describe, expect, it, vi } from 'vitest'
import type { Transport } from './client/transport'
import type { Invocation, JmapRequest } from './client/types/core'
import { createJmapCalendars } from './calendars'
import type { CalendarEvent, Participant } from '../../domain/calendar'
import { fromEvent, toEvent, toNotification, type JmapCalendarEvent } from './calendars'

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
  recurrenceOverrides: {},
  participants,
  isOrganizerCopy: true,
})

describe('recurrence overrides', () => {
  it('keeps every patch whole, including fields mel has no use for', () => {
    // Stalwart stamps `updated` into each patch, and another client may write
    // anything else. mel rewrites the whole map when it saves, so whatever it
    // fails to keep here is what it silently deletes there.
    const e = toEvent({
      ...base,
      recurrenceOverrides: {
        '2026-09-17T10:00:00': { start: '2026-09-17T14:00:00', updated: '2026-09-01T00:00:00Z' },
        '2026-09-24T10:00:00': { excluded: true },
      },
    })

    expect(e.recurrenceOverrides).toEqual({
      '2026-09-17T10:00:00': { start: '2026-09-17T14:00:00', updated: '2026-09-01T00:00:00Z' },
      '2026-09-24T10:00:00': { excluded: true },
    })
    expect(fromEvent(e)['recurrenceOverrides']).toEqual(e.recurrenceOverrides)
  })

  it('drops an entry that is not a patch at all', () => {
    const e = toEvent({
      ...base,
      recurrenceOverrides: { '2026-09-17T10:00:00': null as never, ok: { excluded: true } },
    })

    expect(Object.keys(e.recurrenceOverrides)).toEqual(['ok'])
  })

  it('sends null rather than nothing when the last override is gone', () => {
    // An omitted property leaves the server's copy alone, so an occurrence put
    // back into the series would stay excluded.
    expect(fromEvent(domainEvent([]))['recurrenceOverrides']).toBeNull()
  })
})

describe('alerts', () => {
  const reminder = {
    a1: {
      '@type': 'Alert',
      trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' },
      action: 'display',
      updated: '2026-09-01T00:00:00Z',
    },
    mail: { action: 'email', trigger: { offset: '-P1D' } },
  }

  it('keeps every alert whole, including the ones mel does not show', () => {
    // mel writes the whole map back on save, so an email alert set elsewhere
    // survives only if it is kept here.
    expect(toEvent({ ...base, alerts: reminder }).alerts).toEqual(reminder)
  })

  it('drops an entry that is not an alert at all', () => {
    expect(toEvent({ ...base, alerts: { ok: {}, bad: 'x' } as never }).alerts).toEqual({ ok: {} })
  })

  it('writes them back as they were', () => {
    expect(fromEvent(toEvent({ ...base, alerts: reminder }))['alerts']).toEqual(reminder)
  })

  it('sends null rather than nothing when the last one is gone', () => {
    // Absent would leave the server's copy in place.
    expect(fromEvent({ ...domainEvent([]), alerts: {} })['alerts']).toBeNull()
  })

  it('sends nothing for an event whose alerts were never read', () => {
    // A row synced before alerts were kept has none *known*, which is not none:
    // null here would delete reminders another client set.
    expect(fromEvent(domainEvent([]))['alerts']).toBeUndefined()
  })
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

describe('the online meeting link', () => {
  it('reads the first virtual location as the meeting link', () => {
    const e = toEvent({
      ...base,
      virtualLocations: { v1: { uri: 'https://meet.example/abc' }, v2: { uri: 'https://other' } },
    })
    expect(e.meetingUrl).toBe('https://meet.example/abc')
  })

  it('reads an event without one as known-empty', () => {
    expect(toEvent(base).meetingUrl).toBe('')
  })

  it('round-trips through the wire shape', () => {
    const wire = fromEvent({
      ...domainEvent([]),
      meetingUrl: 'https://meet.example/abc',
    }) as unknown as JmapCalendarEvent
    expect(wire.virtualLocations).toEqual({
      v0: { '@type': 'VirtualLocation', name: 'Meeting', uri: 'https://meet.example/abc' },
    })
    expect(toEvent({ ...wire, id: 'e1' }).meetingUrl).toBe('https://meet.example/abc')
  })

  it('sends null on update when the link was removed, so the server drops it too', async () => {
    const { provider, sent } = capturing({ updated: { e1: null } })
    await provider.updateEvent({ ...domainEvent([]), meetingUrl: '' })
    const patch = (sent[0]!['update'] as Record<string, Record<string, unknown>>)['e1']!
    expect(patch['virtualLocations']).toBeNull()
  })

  it("leaves the server's link alone when this copy never read one", async () => {
    const { provider, sent } = capturing({ updated: { e1: null } })
    await provider.updateEvent(domainEvent([]))
    const patch = (sent[0]!['update'] as Record<string, Record<string, unknown>>)['e1']!
    expect(patch['virtualLocations']).toBeUndefined()
  })

  it('does not send nulls when creating', async () => {
    const { provider, sent } = capturing({ created: { e0: { id: 'n' } } })
    await provider.createEvent({ ...domainEvent([]), meetingUrl: '' })
    const created = (sent[0]!['create'] as Record<string, Record<string, unknown>>)['e0']!
    expect(created['virtualLocations']).toBeUndefined()
    expect(created['locations']).toBeUndefined()
  })
})

describe('free/busy, privacy and categories', () => {
  it('reads busy and public when the server says nothing', () => {
    const e = toEvent(base)
    expect(e.freeBusyStatus).toBe('busy')
    expect(e.privacy).toBe('public')
    expect(e.categories).toEqual([])
  })

  it('reads what the server holds', () => {
    const e = toEvent({
      ...base,
      freeBusyStatus: 'free',
      privacy: 'secret',
      categories: { Work: true, Old: false, Family: true },
    })
    expect(e.freeBusyStatus).toBe('free')
    expect(e.privacy).toBe('secret')
    expect(e.categories).toEqual(['Work', 'Family'])
  })

  it('treats a value it does not know as the default', () => {
    const e = toEvent({ ...base, freeBusyStatus: 'oof', privacy: 'confidential' })
    expect(e.freeBusyStatus).toBe('busy')
    expect(e.privacy).toBe('public')
  })

  it('round-trips through the wire shape', () => {
    const wire = fromEvent({
      ...domainEvent([]),
      freeBusyStatus: 'free',
      privacy: 'private',
      categories: ['Work', 'Family'],
    }) as unknown as JmapCalendarEvent
    expect(wire.categories).toEqual({ Work: true, Family: true })
    const back = toEvent({ ...wire, id: 'e1' })
    expect([back.freeBusyStatus, back.privacy, back.categories]).toEqual([
      'free',
      'private',
      ['Work', 'Family'],
    ])
  })

  it('leaves defaults off the wire when creating', () => {
    const wire = fromEvent({
      ...domainEvent([]),
      freeBusyStatus: 'busy',
      privacy: 'public',
      categories: [],
    })
    expect(wire['freeBusyStatus']).toBeUndefined()
    expect(wire['privacy']).toBeUndefined()
    expect(wire['categories']).toBeUndefined()
  })

  it('sends null on update when they went back to the default', async () => {
    const { provider, sent } = capturing({ updated: { e1: null } })
    await provider.updateEvent({
      ...domainEvent([]),
      freeBusyStatus: 'busy',
      privacy: 'public',
      categories: [],
    })
    const patch = (sent[0]!['update'] as Record<string, Record<string, unknown>>)['e1']!
    expect(patch['freeBusyStatus']).toBeNull()
    expect(patch['privacy']).toBeNull()
    expect(patch['categories']).toBeNull()
  })

  it('leaves the server alone when this copy never read them', async () => {
    const { provider, sent } = capturing({ updated: { e1: null } })
    await provider.updateEvent(domainEvent([]))
    const patch = (sent[0]!['update'] as Record<string, Record<string, unknown>>)['e1']!
    expect(patch['freeBusyStatus']).toBeUndefined()
    expect(patch['privacy']).toBeUndefined()
    expect(patch['categories']).toBeUndefined()
  })
})

describe('editing the calendar list', () => {
  const sentSet = (sent: Array<Record<string, unknown>>) => sent[0]!

  it('creates a subscribed calendar with its name and colour', async () => {
    const { provider, sent } = capturing({ created: { c0: { id: 'new' } } })
    const r = await provider.editCalendar({ create: { name: 'Work', color: '#ff0000' } })
    expect(r).toEqual({ id: 'new', failure: null })
    expect(sentSet(sent)['create']).toEqual({
      c0: { name: 'Work', color: '#ff0000', isSubscribed: true },
    })
    expect(sentSet(sent)['destroy']).toBeUndefined()
  })

  it('reports why a create was refused', async () => {
    const { provider } = capturing({ notCreated: { c0: { type: 'forbidden' } } })
    const r = await provider.editCalendar({ create: { name: 'x', color: null } })
    expect(r.id).toBeNull()
    expect(r.failure).toMatchObject({ type: 'forbidden' })
  })

  it('renames and recolours by patch, without sending the id inside it', async () => {
    const { provider, sent } = capturing({ updated: { c1: null } })
    const r = await provider.editCalendar({ update: { id: 'c1', name: 'Home', color: null } })
    expect(r).toEqual({ id: 'c1', failure: null })
    const patch = (sentSet(sent)['update'] as Record<string, Record<string, unknown>>)['c1']!
    expect(patch['name']).toBe('Home')
    expect(patch['color']).toBeNull()
    expect(patch['id']).toBeUndefined()
  })

  it('refuses to delete a calendar with events unless told to take them along', async () => {
    const { provider, sent } = capturing({
      notDestroyed: { c1: { type: 'calendarHasEvent', description: 'Calendar is not empty.' } },
    })
    const r = await provider.editCalendar({ destroy: 'c1' })
    expect(sentSet(sent)['destroy']).toEqual(['c1'])
    expect(sentSet(sent)['onDestroyRemoveEvents']).toBe(false)
    expect(r.failure).toMatchObject({ type: 'calendarHasEvent' })
  })

  it('deletes the events with the calendar when asked', async () => {
    const { provider, sent } = capturing({ destroyed: ['c1'] })
    const r = await provider.editCalendar({ destroy: 'c1', destroyWithEvents: true })
    expect(sentSet(sent)['onDestroyRemoveEvents']).toBe(true)
    expect(r.failure).toBeNull()
  })

  it('does not mention onDestroyRemoveEvents for a create or an update', async () => {
    const { provider, sent } = capturing({ created: { c0: { id: 'n' } } })
    await provider.editCalendar({ create: { name: 'x', color: null } })
    expect(
      'onDestroyRemoveEvents' in sentSet(sent) && sentSet(sent)['onDestroyRemoveEvents'],
    ).toBeFalsy()
  })
})

describe('links (attachments)', () => {
  const enclosure = { rel: 'enclosure', href: 'https://x/a.pdf', title: 'a.pdf', custom: 1 }

  it('keeps every link whole, including ones that are not attachments', () => {
    const e = toEvent({
      ...base,
      links: { a: enclosure, b: { rel: 'describedby', href: 'https://y' } },
    })
    expect(e.links).toEqual({ a: enclosure, b: { rel: 'describedby', href: 'https://y' } })
  })

  it('reads an event without links as known-empty', () => {
    expect(toEvent(base).links).toEqual({})
  })

  it('writes the map back on update', async () => {
    const { provider, sent } = capturing({ updated: { e1: null } })
    await provider.updateEvent({ ...domainEvent([]), links: { a: enclosure } })
    const patch = (sent[0]!['update'] as Record<string, Record<string, unknown>>)['e1']!
    expect(patch['links']).toEqual({ a: enclosure })
  })

  it('sends null once the last one was removed, so the server drops it too', async () => {
    const { provider, sent } = capturing({ updated: { e1: null } })
    await provider.updateEvent({ ...domainEvent([]), links: {} })
    const patch = (sent[0]!['update'] as Record<string, Record<string, unknown>>)['e1']!
    expect(patch['links']).toBeNull()
  })

  it("leaves the server's links alone when this copy never read any", async () => {
    const { provider, sent } = capturing({ updated: { e1: null } })
    await provider.updateEvent(domainEvent([]))
    const patch = (sent[0]!['update'] as Record<string, Record<string, unknown>>)['e1']!
    expect(patch['links']).toBeUndefined()
  })
})

describe('clearing a location or description', () => {
  it('sends null on update, since an absent key keeps what the server has', async () => {
    const { provider, sent } = capturing({ updated: { e1: null } })
    await provider.updateEvent(domainEvent([]))
    const patch = (sent[0]!['update'] as Record<string, Record<string, unknown>>)['e1']!
    expect(patch['locations']).toBeNull()
    expect(patch['description']).toBeNull()
  })

  it('keeps a location that is set', async () => {
    const { provider, sent } = capturing({ updated: { e1: null } })
    await provider.updateEvent({ ...domainEvent([]), location: 'Room 4', description: 'Hi' })
    const patch = (sent[0]!['update'] as Record<string, Record<string, unknown>>)['e1']!
    expect(patch['locations']).toEqual({ l0: { '@type': 'Location', name: 'Room 4' } })
    expect(patch['description']).toBe('Hi')
  })
})

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

/**
 * A transport answering each call by method name; an array answers repeated
 * calls of the same name in turn, and a value carrying `error` is the server
 * refusing that one call.
 */
function serverAnswering(byName: Record<string, unknown>) {
  const sent: Array<[string, Record<string, unknown>]> = []
  const taken: Record<string, number> = {}
  const transport: Transport = {
    fetchRaw: vi.fn(),
    request: async (req: JmapRequest) => ({
      methodResponses: req.methodCalls.map(([name, args, callId]: Invocation) => {
        sent.push([name, args as Record<string, unknown>])
        const a = byName[name]
        const value = Array.isArray(a) ? a[(taken[name] = (taken[name] ?? 0) + 1) - 1] : a
        if (value && typeof value === 'object' && 'error' in (value as object)) {
          return ['error', (value as { error: unknown }).error, callId]
        }
        return [name, value ?? {}, callId]
      }),
      sessionState: 's',
    }),
  } as never
  return { provider: createJmapCalendars(transport, 'acc1'), sent }
}

describe('syncing calendars and their events', () => {
  it('asks for everything at once when there is no state yet', async () => {
    const { provider, sent } = serverAnswering({
      'Calendar/get': { list: [{ id: 'c1', name: 'Privat' }], state: 'cal-1' },
    })

    const page = await provider.syncCalendars(undefined)

    // ids: null is "all of them"; an empty array would ask for none.
    expect(sent[0]![1]['ids']).toBeNull()
    expect(page).toMatchObject({ updated: [], destroyedIds: [], newState: 'cal-1', hasMore: false })
    expect(page.created).toHaveLength(1)
  })

  it('fetches both sides of a delta in one request', async () => {
    const { provider, sent } = serverAnswering({
      'CalendarEvent/changes': {
        created: ['new'],
        updated: ['old'],
        destroyed: ['gone'],
        newState: 'ev-2',
        hasMoreChanges: false,
      },
      'CalendarEvent/get': [{ list: [{ ...base, id: 'new' }] }, { list: [{ ...base, id: 'old' }] }],
    })

    const page = await provider.syncEvents('ev-1')

    expect(sent.map(([name]) => name)).toEqual([
      'CalendarEvent/changes',
      'CalendarEvent/get',
      'CalendarEvent/get',
    ])
    expect(page.created.map((e) => e.id)).toEqual(['new'])
    expect(page.updated.map((e) => e.id)).toEqual(['old'])
    expect(page.destroyedIds).toEqual(['gone'])
  })

  it('passes on that the server has more to give', async () => {
    const { provider } = serverAnswering({
      'CalendarEvent/changes': {
        created: [],
        updated: [],
        destroyed: [],
        newState: 'ev-2',
        hasMoreChanges: true,
      },
      'CalendarEvent/get': { list: [] },
    })

    expect((await provider.syncEvents('ev-1')).hasMore).toBe(true)
  })

  it('raises a forgotten state as its own kind of failure', async () => {
    /*
     * The engine catches exactly this to wipe and refetch. A generic error
     * would be retried against a state that is never coming back.
     */
    const { provider } = serverAnswering({
      'Calendar/changes': { error: { type: 'cannotCalculateChanges' } },
      'Calendar/get': { list: [] },
    })

    await expect(provider.syncCalendars('ancient')).rejects.toThrow()
  })
})

describe('event notifications', () => {
  const rsvp = (status: string, by = 'bob@localhost') => ({
    id: 'n1',
    created: '2026-09-19T15:41:21Z',
    type: 'updated',
    calendarEventId: 'ev1',
    changedBy: { name: 'Bob (dev)', email: by },
    eventPatch: {
      title: 'Planning',
      participants: {
        p1: { calendarAddress: 'mailto:alice@localhost', roles: { owner: true } },
        p2: { calendarAddress: `mailto:${by}`, participationStatus: status },
      },
    },
  })

  it.each(['accepted', 'declined', 'tentative'] as const)(
    'reads a reply of %s as that',
    (status) => {
      expect(toNotification(rsvp(status)).kind).toBe(status)
    },
  )

  it('names who did it, which event and when', () => {
    expect(toNotification(rsvp('accepted'))).toMatchObject({
      id: 'n1',
      by: 'Bob (dev)',
      byEmail: 'bob@localhost',
      eventId: 'ev1',
      title: 'Planning',
      created: '2026-09-19T15:41:21Z',
    })
  })

  it('reads an update in which the sender did not answer as a plain change', () => {
    // Bob moved the time; his own entry is still waiting for an answer.
    expect(toNotification(rsvp('needs-action')).kind).toBe('changed')
  })

  it("looks only at the sender's own entry, not at everyone's answers", () => {
    const n = rsvp('needs-action')
    ;(n.eventPatch.participants as Record<string, unknown>)['p3'] = {
      calendarAddress: 'mailto:carol@localhost',
      participationStatus: 'accepted',
    }
    expect(toNotification(n).kind).toBe('changed')
  })

  it('matches the sender case-insensitively', () => {
    const n = rsvp('accepted', 'Bob@Localhost')
    n.changedBy.email = 'bob@localhost'
    expect(toNotification(n).kind).toBe('accepted')
  })

  it('reads created as an invitation and destroyed as a cancellation', () => {
    expect(toNotification({ id: 'a', type: 'created' }).kind).toBe('invited')
    expect(toNotification({ id: 'a', type: 'destroyed' }).kind).toBe('cancelled')
  })

  it('falls back to the address when the sender has no name, and to blanks for the rest', () => {
    const n = toNotification({ id: 'a', type: 'updated', changedBy: { email: 'x@y' } })
    expect(n).toMatchObject({ by: 'x@y', title: '', comment: '', eventId: null, kind: 'changed' })
  })

  it('asks for the properties Stalwart leaves out of a plain get', async () => {
    const { provider, sent } = serverAnswering({
      'CalendarEventNotification/get': { list: [rsvp('accepted')], state: 'n-1' },
    })
    const page = await provider.syncEventNotifications(undefined)
    const props = sent[0]![1]['properties'] as string[]
    expect(props).toEqual(expect.arrayContaining(['calendarEventId', 'eventPatch', 'changedBy']))
    expect(page.created).toHaveLength(1)
    expect(page.newState).toBe('n-1')
  })

  it('does not take the calendar sync down when the server has no notifications', async () => {
    const { provider } = serverAnswering({
      'CalendarEventNotification/get': { error: { type: 'unknownMethod' } },
    })
    await expect(provider.syncEventNotifications(undefined)).resolves.toMatchObject({
      created: [],
      hasMore: false,
    })
  })

  it('still reports any other failure', async () => {
    const { provider } = serverAnswering({
      'CalendarEventNotification/get': { error: { type: 'serverFail' } },
    })
    await expect(provider.syncEventNotifications(undefined)).rejects.toThrow()
  })

  it('dismisses by destroying, and reports a refusal', async () => {
    const ok = serverAnswering({ 'CalendarEventNotification/set': { destroyed: ['n1'] } })
    await expect(ok.provider.dismissEventNotifications(['n1'])).resolves.toBeNull()
    expect(ok.sent[0]![1]['destroy']).toEqual(['n1'])
    const refused = serverAnswering({
      'CalendarEventNotification/set': { notDestroyed: { n1: { type: 'notFound' } } },
    })
    await expect(refused.provider.dismissEventNotifications(['n1'])).resolves.toMatchObject({
      type: 'notFound',
    })
  })
})
