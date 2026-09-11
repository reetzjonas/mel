import type { EmailBody } from '../domain/email'
import type { MessageMetadata } from '../domain/messageMetadata'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { connectionFor } from '../sync/connections'

/** Body cache with lazy fetch-through to the provider. */
export async function getEmailBody(accountId: string, emailId: string): Promise<EmailBody | null> {
  const cached = await db.bodyCache.get([accountId, emailId])
  if (cached) {
    void db.bodyCache.update([accountId, emailId], { lastAccess: Date.now() })
    return openEnvelope(cached.payload)
  }
  const conn = await connectionFor(accountId)
  if (!conn.mail) return null
  const body = await conn.mail.getEmailBody(emailId)
  if (body) {
    await db.bodyCache.put({
      accountId,
      emailId,
      lastAccess: Date.now(),
      payload: sealPlain(body),
    })
  }
  return body
}

/**
 * A message's raw headers, straight from the server — never cached.
 *
 * Unlike a body this is not part of reading mail: it is opened deliberately,
 * rarely, and would otherwise sit in IndexedDB carrying routing information
 * about every message anyone ever inspected. Offline it simply fails, and the
 * view says so instead of showing a stale answer.
 */
export async function getMessageMetadata(
  accountId: string,
  emailId: string,
): Promise<MessageMetadata | null> {
  const conn = await connectionFor(accountId)
  if (!conn.mail) return null
  return conn.mail.getEmailMetadata(emailId)
}

/**
 * Saves the original message as an .eml file — the export half of the metadata
 * view, and the only way to get at the parts of a message the app does not
 * model (every header, every part, verbatim).
 */
export async function downloadOriginal(
  accountId: string,
  blobId: string,
  name: string,
): Promise<boolean> {
  const conn = await connectionFor(accountId)
  if (!conn.mail) return false
  const blob = await conn.mail.downloadBlob(blobId, 'message/rfc822', name)
  const url = URL.createObjectURL(new Blob([blob], { type: 'message/rfc822' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return true
}
