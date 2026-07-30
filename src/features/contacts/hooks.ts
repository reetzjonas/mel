import { useLiveQuery } from 'dexie-react-hooks'
import { displayName, type Contact } from '../../domain/contact'
import { db } from '../../storage/db'
import { openEnvelope } from '../../storage/envelope'

export function useContacts(accountId: string | undefined): Contact[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId) return []
    const rows = await db.contacts.where('accountId').equals(accountId).toArray()
    // Locale-aware sort by display name (stored sortKeys may predate the
    // display-name ordering; contact lists are small enough to sort here).
    return rows
      .map((r) => openEnvelope(r.payload))
      .sort((a, b) =>
        displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' }),
      )
  }, [accountId])
}

export function useContact(
  accountId: string | undefined,
  contactId: string | undefined,
): Contact | null | undefined {
  return useLiveQuery(async () => {
    if (!accountId || !contactId) return null
    const row = await db.contacts.get([accountId, contactId])
    return row ? openEnvelope(row.payload) : null
  }, [accountId, contactId])
}

export function useDefaultAddressBookId(accountId: string | undefined): string | undefined {
  return useLiveQuery(async () => {
    if (!accountId) return undefined
    const rows = await db.addressBooks.where('accountId').equals(accountId).toArray()
    const books = rows.map((r) => openEnvelope(r.payload))
    return (books.find((b) => b.isDefault) ?? books[0])?.id
  }, [accountId])
}
