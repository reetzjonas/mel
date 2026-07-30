import type { EmailBody } from '../domain/email'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { connectionFor } from '../sync/connections'

/** Body cache with lazy fetch-through to the provider. */
export async function getEmailBody(
  accountId: string,
  emailId: string,
): Promise<EmailBody | null> {
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
