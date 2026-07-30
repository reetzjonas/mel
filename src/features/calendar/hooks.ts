import { useLiveQuery } from 'dexie-react-hooks'
import type { Calendar, CalendarEvent } from '../../domain/calendar'
import { db } from '../../storage/db'
import { openEnvelope } from '../../storage/envelope'

export function useCalendars(accountId: string | undefined): Calendar[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId) return []
    const rows = await db.calendars.where('accountId').equals(accountId).toArray()
    return rows.map((r) => openEnvelope(r.payload))
  }, [accountId])
}

export function useEvents(accountId: string | undefined): CalendarEvent[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId) return []
    const rows = await db.events.where('accountId').equals(accountId).toArray()
    return rows.map((r) => openEnvelope(r.payload))
  }, [accountId])
}
