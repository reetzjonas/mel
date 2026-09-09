import type { CalendarEvent, ParticipationStatus } from '../domain/calendar'
import { db, type EventRow } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { connectionFor } from '../sync/connections'
import { enqueue } from '../sync/outbox'

function toRow(accountId: string, e: CalendarEvent): EventRow {
  return {
    accountId,
    id: e.id,
    calendarIds: Object.keys(e.calendarIds),
    payload: sealPlain(e),
  }
}

/** Server-first create (real id for navigation); offline falls back to the outbox. */
export async function createEvent(
  accountId: string,
  event: Omit<CalendarEvent, 'id'>,
): Promise<string> {
  const uid = event.uid || crypto.randomUUID()
  const eventWithUid = { ...event, uid }
  if (navigator.onLine) {
    try {
      const conn = await connectionFor(accountId)
      if (conn.calendars) {
        const r = await conn.calendars.createEvent({ ...eventWithUid, id: '' })
        if (r.failure) throw new Error(r.failure.description ?? r.failure.type)
        const full: CalendarEvent = { ...eventWithUid, id: r.id! }
        await db.events.put(toRow(accountId, full))
        return r.id!
      }
    } catch (e) {
      if (!(e instanceof Error && (e as { transient?: boolean }).transient)) throw e
    }
  }
  const tempId = `local-${crypto.randomUUID()}`
  const full: CalendarEvent = { ...eventWithUid, id: tempId }
  await db.events.put(toRow(accountId, full))
  await enqueue(accountId, { kind: 'event.create', event: full, tempId })
  return tempId
}

export async function updateEvent(accountId: string, event: CalendarEvent): Promise<void> {
  await db.events.put(toRow(accountId, event))
  if (event.id.startsWith('local-')) return
  await enqueue(accountId, { kind: 'event.update', event })
}

export async function deleteEvent(accountId: string, eventId: string): Promise<void> {
  await db.events.delete([accountId, eventId])
  if (eventId.startsWith('local-')) return
  await enqueue(accountId, { kind: 'event.destroy', ids: [eventId] })
}

/**
 * Answer an invitation. Optimistic locally, then the outbox tells the server,
 * which emails the iTIP reply to the organizer.
 */
export async function rsvpEvent(
  accountId: string,
  event: CalendarEvent,
  selfEmail: string,
  status: ParticipationStatus,
): Promise<void> {
  const me = findSelf(event, selfEmail)
  if (!me) return
  const updated: CalendarEvent = {
    ...event,
    participants: event.participants.map((p) => (p.id === me.id ? { ...p, status } : p)),
  }
  await db.events.put(toRow(accountId, updated))
  if (event.id.startsWith('local-')) return
  await enqueue(accountId, {
    kind: 'event.rsvp',
    eventId: event.id,
    participantId: me.id,
    status,
  })
}

/** The participant entry for the logged-in user, if they were invited. */
export function findSelf(event: CalendarEvent, selfEmail: string) {
  const me = selfEmail.trim().toLowerCase()
  if (!me) return undefined
  return event.participants.find((p) => p.email.toLowerCase() === me && !p.isOrganizer)
}
