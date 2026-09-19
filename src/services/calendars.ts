import type { Calendar } from '../domain/calendar'
import type { SetFailure } from '../providers/types'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { connectionFor } from '../sync/connections'
import { syncAccount } from '../sync/engine'

/**
 * Managing the calendar list — create, rename, recolour, delete.
 *
 * Server-first, like folders and unlike events: a calendar has no offline story
 * (an event cannot be filed into one the server has never heard of) and a
 * queued create would leave the sidebar showing a calendar that may yet be
 * refused. Each call reports the server's reason as text, or null on success.
 *
 * On success the local copy is written straight away and a full sync follows in
 * the background. Awaiting the sync instead kept the dialog open — and the
 * sidebar half-updated behind it — for as long as a whole account sync takes.
 */

/** Why a delete was refused, so the dialog can offer the matching way out. */
export type CalendarDeleteBlocker = 'hasEvents' | 'other'

export interface CalendarDeleteOutcome {
  ok: boolean
  blocker?: CalendarDeleteBlocker
  message?: string
}

const message = (f: SetFailure | null) => (f ? (f.description ?? f.type) : null)

export async function createCalendar(
  accountId: string,
  name: string,
  color: string | null,
): Promise<string | null> {
  const conn = await connectionFor(accountId)
  if (!conn.calendars) return 'noProvider'
  const r = await conn.calendars.editCalendar({ create: { name, color } })
  if (!r.failure && r.id) {
    const calendar: Calendar = {
      id: r.id,
      name,
      color,
      isDefault: false,
      mayWrite: true,
      mayDelete: true,
    }
    await db.calendars.put({ accountId, id: r.id, payload: sealPlain(calendar) })
  }
  void syncAccount(accountId)
  return message(r.failure)
}

/** Only what changed needs passing; `color: null` removes a colour. */
export async function updateCalendar(
  accountId: string,
  id: string,
  changes: { name?: string; color?: string | null },
): Promise<string | null> {
  const conn = await connectionFor(accountId)
  if (!conn.calendars) return 'noProvider'
  const r = await conn.calendars.editCalendar({ update: { id, ...changes } })
  if (!r.failure) {
    const row = await db.calendars.get([accountId, id])
    if (row) {
      const next = { ...openEnvelope(row.payload), ...changes }
      await db.calendars.put({ ...row, payload: sealPlain(next) })
    }
  }
  void syncAccount(accountId)
  return message(r.failure)
}

/**
 * Delete a calendar. The server refuses one that still holds events
 * (`calendarHasEvent`); `withEvents` deletes them along with it, which is the
 * choice the dialog puts to the person rather than making it silently.
 */
export async function deleteCalendar(
  accountId: string,
  id: string,
  opts: { withEvents?: boolean } = {},
): Promise<CalendarDeleteOutcome> {
  const conn = await connectionFor(accountId)
  if (!conn.calendars) return { ok: false, blocker: 'other', message: 'noProvider' }
  const { failure } = await conn.calendars.editCalendar({
    destroy: id,
    destroyWithEvents: opts.withEvents ?? false,
  })
  if (!failure) await db.calendars.delete([accountId, id])
  void syncAccount(accountId)
  if (!failure) return { ok: true }
  return {
    ok: false,
    blocker: failure.type === 'calendarHasEvent' ? 'hasEvents' : 'other',
    message: message(failure) ?? undefined,
  }
}
