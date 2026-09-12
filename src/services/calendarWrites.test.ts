import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../domain/calendar'
import { db } from '../storage/db'
import { openEnvelope } from '../storage/envelope'

const enqueued: Array<Record<string, unknown>> = []
vi.mock('../sync/outbox', () => ({
  enqueue: (_accountId: string, action: Record<string, unknown>) => {
    enqueued.push(action)
    return Promise.resolve(1)
  },
}))

let createOnServer: () => { id: string | null; failure: unknown } = () => ({
  id: 'server-id',
  failure: null,
})
vi.mock('../sync/connections', () => ({
  connectionFor: () =>
    Promise.resolve({ calendars: { createEvent: () => Promise.resolve(createOnServer()) } }),
}))

const { createEvent, deleteEvent, findSelf, rsvpEvent, updateEvent } = await import('./calendar')

const ACC = 'acc'
const ME = 'alice@example.test'

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({
    id: 'server-id',
    calendarIds: { c1: true },
    uid: 'uid-1',
    title: 'Standup',
    description: '',
    location: '',
    start: '2026-09-09T10:00:00',
    timeZone: 'Europe/Berlin',
    duration: 'PT30M',
    showWithoutTime: false,
    status: 'confirmed',
    recurrenceRule: null,
    participants: [],
    isOrganizerCopy: false,
    ...over,
  }) as unknown as CalendarEvent

const invited = (over: Partial<CalendarEvent> = {}) =>
  event({
    participants: [
      {
        id: 'p-org',
        email: 'bob@example.test',
        name: 'Bob',
        isOrganizer: true,
        status: 'accepted',
      },
      { id: 'p-me', email: ME, name: 'Alice', isOrganizer: false, status: 'needs-action' },
    ],
    ...over,
  } as Partial<CalendarEvent>)

const online = (value: boolean) =>
  Object.defineProperty(navigator, 'onLine', { configurable: true, value })

beforeEach(async () => {
  enqueued.length = 0
  createOnServer = () => ({ id: 'server-id', failure: null })
  online(true)
  await db.events.where('accountId').equals(ACC).delete()
})

describe('creating an event', () => {
  it('gives an event without one a uid of its own', async () => {
    // The uid is what ties an invitation to its replies across mailboxes;
    // two events sharing one, or having none, breaks the whole iTIP round.
    const { uid, ...rest } = event()
    void uid
    await createEvent(ACC, { ...rest, uid: '' } as never)

    const row = await db.events.get([ACC, 'server-id'])
    expect(openEnvelope(row!.payload).uid).toBeTruthy()
  })

  it('keeps a uid the caller already chose', async () => {
    const { id, ...rest } = event({ uid: 'from-an-invitation' })
    void id
    await createEvent(ACC, rest as never)

    expect(openEnvelope((await db.events.get([ACC, 'server-id']))!.payload).uid).toBe(
      'from-an-invitation',
    )
  })

  it('keeps and queues the event when offline', async () => {
    online(false)
    const { id, ...rest } = event()
    void id

    const newId = await createEvent(ACC, rest as never)

    expect(newId).toMatch(/^local-/)
    expect(enqueued[0]).toMatchObject({ kind: 'event.create', tempId: newId })
  })

  it('hands a refusal that will not change to the caller instead of queueing it', async () => {
    createOnServer = () => ({ id: null, failure: { type: 'invalidProperties', permanent: true } })
    const { id, ...rest } = event()
    void id

    await expect(createEvent(ACC, rest as never)).rejects.toThrow('invalidProperties')
    expect(enqueued).toEqual([])
  })
})

describe('editing and removing an event', () => {
  it('does not queue a change to an event the server has never seen', async () => {
    // Its creation is still queued and carries the whole event with it.
    await updateEvent(ACC, event({ id: 'local-x' }))
    expect(enqueued).toEqual([])

    await deleteEvent(ACC, 'local-x')
    expect(enqueued).toEqual([])
  })

  it('queues both for one the server knows', async () => {
    await updateEvent(ACC, event())
    await deleteEvent(ACC, 'server-id')

    expect(enqueued.map((a) => a['kind'])).toEqual(['event.update', 'event.destroy'])
  })
})

describe('answering an invitation', () => {
  it('changes only the answering participant’s status', async () => {
    await rsvpEvent(ACC, invited(), ME, 'accepted')

    const stored = openEnvelope((await db.events.get([ACC, 'server-id']))!.payload)
    expect(stored.participants.map((p) => p.status)).toEqual(['accepted', 'accepted'])
    expect(stored.participants[1]).toMatchObject({ id: 'p-me', status: 'accepted' })
  })

  it('queues the reply, so the server sends the iTIP mail to the organiser', async () => {
    await rsvpEvent(ACC, invited(), ME, 'declined')

    expect(enqueued[0]).toMatchObject({
      kind: 'event.rsvp',
      eventId: 'server-id',
      participantId: 'p-me',
      status: 'declined',
    })
  })

  it('does nothing for an event this account was not invited to', async () => {
    // Nobody to answer as: writing a status would invent a participant.
    await rsvpEvent(ACC, event(), ME, 'accepted')

    expect(enqueued).toEqual([])
    expect(await db.events.get([ACC, 'server-id'])).toBeUndefined()
  })
})

describe('findSelf', () => {
  it('matches the address however it is capitalised', () => {
    // Servers hand addresses back in whatever case the sender typed.
    expect(findSelf(invited(), 'ALICE@Example.Test')?.id).toBe('p-me')
  })

  it('never answers with the organiser', () => {
    /*
     * The organiser's own copy lists them as a participant too. Treating that
     * as "you" would offer the organiser an RSVP to their own invitation, and
     * the reply would go to themselves.
     */
    const ownInvitation = invited({ isOrganizerCopy: true })
    expect(findSelf(ownInvitation, 'bob@example.test')).toBeUndefined()
  })

  it('is undefined without an address to look for', () => {
    expect(findSelf(invited(), '')).toBeUndefined()
    expect(findSelf(invited(), '   ')).toBeUndefined()
  })
})
