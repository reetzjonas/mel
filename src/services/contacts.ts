import { contactSortKey, type Contact } from '../domain/contact'
import { db, type ContactRow } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { enqueue } from '../sync/outbox'

function toRow(accountId: string, c: Contact): ContactRow {
  return {
    accountId,
    id: c.id,
    addressBookIds: Object.keys(c.addressBookIds),
    sortKey: contactSortKey(c),
    payload: sealPlain(c),
  }
}

/**
 * Create server-first when online (so callers get the real id); fall back to
 * an optimistic temp row + outbox when offline or the request fails transiently.
 */
export async function createContact(
  accountId: string,
  contact: Omit<Contact, 'id'>,
): Promise<string> {
  if (navigator.onLine) {
    try {
      const { connectionFor } = await import('../sync/connections')
      const conn = await connectionFor(accountId)
      if (conn.contacts) {
        const r = await conn.contacts.createContact({ ...contact, id: '' })
        if (r.failure) throw new Error(r.failure.description ?? r.failure.type)
        const full: Contact = { ...contact, id: r.id! }
        await db.contacts.put(toRow(accountId, full))
        return r.id!
      }
    } catch (e) {
      // Permanent validation errors surface to the caller; network errors
      // fall through to the offline path.
      if (!(e instanceof Error && 'transient' in e && (e as { transient?: boolean }).transient))
        throw e
    }
  }
  const tempId = `local-${crypto.randomUUID()}`
  const full: Contact = { ...contact, id: tempId }
  await db.contacts.put(toRow(accountId, full))
  await enqueue(accountId, { kind: 'contact.create', contact: full, tempId })
  return tempId
}

export async function updateContact(accountId: string, contact: Contact): Promise<void> {
  await db.contacts.put(toRow(accountId, contact))
  if (contact.id.startsWith('local-')) return // creation still queued; it carries no edits yet
  await enqueue(accountId, { kind: 'contact.update', contact })
}

export async function deleteContact(accountId: string, contactId: string): Promise<void> {
  await db.contacts.delete([accountId, contactId])
  if (contactId.startsWith('local-')) return
  await enqueue(accountId, { kind: 'contact.destroy', ids: [contactId] })
}

export interface Suggestion {
  name: string
  email: string
}

/** Prefix search over cached contacts for compose autocomplete. */
export async function suggestRecipients(accountId: string, input: string): Promise<Suggestion[]> {
  const needle = input.trim().toLowerCase()
  if (needle.length < 2) return []
  const rows = await db.contacts.where('accountId').equals(accountId).toArray()
  const out: Suggestion[] = []
  for (const row of rows) {
    const c = openEnvelope(row.payload)
    const name = [c.given, c.surname].filter(Boolean).join(' ') || c.fullName
    const hay = `${name} ${c.nickname} ${c.emails.map((e) => e.value).join(' ')}`.toLowerCase()
    if (!hay.includes(needle)) continue
    for (const e of c.emails) out.push({ name, email: e.value })
  }
  return out.slice(0, 8)
}
