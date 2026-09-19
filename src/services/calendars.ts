import type { SetFailure } from '../providers/types'
import { connectionFor } from '../sync/connections'
import { syncAccount } from '../sync/engine'

/**
 * Managing the calendar list — create, rename, recolour, delete.
 *
 * Server-first, like folders and unlike events: a calendar has no offline story
 * (an event cannot be filed into one the server has never heard of) and a
 * queued create would leave the sidebar showing a calendar that may yet be
 * refused. Each call reports the server's reason as text, or null on success,
 * and brings the local mirror along afterwards.
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
  await syncAccount(accountId)
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
  await syncAccount(accountId)
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
  await syncAccount(accountId)
  if (!failure) return { ok: true }
  return {
    ok: false,
    blocker: failure.type === 'calendarHasEvent' ? 'hasEvents' : 'other',
    message: message(failure) ?? undefined,
  }
}
