import { db } from '../storage/db'
import { connectionFor } from '../sync/connections'

/**
 * Dismiss notifications, on the server and here.
 *
 * Server-first, and the local rows stay until the server agrees: a dismissal
 * is shared with every other client of the account, so pretending it worked
 * offline would bring the notification back on the next sync — which reads as
 * the app ignoring a click. Null on success, otherwise why not.
 */
export async function dismissNotifications(
  accountId: string,
  ids: string[],
): Promise<string | null> {
  if (ids.length === 0) return null
  try {
    const conn = await connectionFor(accountId)
    if (!conn.calendars) return 'noProvider'
    const failure = await conn.calendars.dismissEventNotifications(ids)
    if (failure) return failure.description ?? failure.type
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  await db.eventNotifications.bulkDelete(ids.map((id) => [accountId, id]))
  return null
}
