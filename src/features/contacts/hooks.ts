import { useLiveQuery } from 'dexie-react-hooks'
import type { Contact } from '../../domain/contact'
import { db } from '../../storage/db'
import { openEnvelope } from '../../storage/envelope'

export function useContacts(accountId: string | undefined): Contact[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId) return []
    const rows = await db.contacts.where('[accountId+sortKey]').between([accountId, ''], [accountId, '￿']).toArray()
    return rows.map((r) => openEnvelope(r.payload))
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
