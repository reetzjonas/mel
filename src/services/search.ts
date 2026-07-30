import type { EmailHeader } from '../domain/email'
import { parseSearch } from '../lib/searchParser'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { connectionFor } from '../sync/connections'

export interface SearchResult {
  headers: EmailHeader[]
  snippets: Record<string, { subject: string | null; preview: string | null }>
}

/** Server-side search; fetched headers are stored so the cache warms up. */
export async function searchEmails(
  accountId: string,
  queryString: string,
  mailboxId?: string,
): Promise<SearchResult | null> {
  const query = parseSearch(queryString)
  if (!query) return null
  const conn = await connectionFor(accountId)
  if (!conn.mail) return null

  const { ids, snippets } = await conn.mail.searchEmails(query, { mailboxId, limit: 100 })
  if (!ids.length) return { headers: [], snippets }

  const rows = await db.emails.bulkGet(ids.map((id) => [accountId, id] as [string, string]))
  const byId = new Map<string, EmailHeader>()
  const missing: string[] = []
  ids.forEach((id, i) => {
    const row = rows[i]
    if (row) byId.set(id, openEnvelope(row.payload))
    else missing.push(id)
  })
  if (missing.length) {
    const fetched = await conn.mail.getEmailHeaders(missing)
    for (const h of fetched) {
      byId.set(h.id, h)
      await db.emails.put({
        accountId,
        id: h.id,
        threadId: h.threadId,
        mailboxIds: Object.keys(h.mailboxIds),
        receivedAt: Date.parse(h.receivedAt),
        unread: h.keywords['$seen'] ? 0 : 1,
        flagged: h.keywords['$flagged'] ? 1 : 0,
        payload: sealPlain(h),
      })
    }
  }
  return { headers: ids.map((id) => byId.get(id)).filter((h): h is EmailHeader => !!h), snippets }
}
