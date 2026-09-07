import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { removeAccount } from './accounts'

// These rows only need their index columns to be real; the sealed payloads are
// never opened here, so a stub stands in for each row's full domain object.
const stub = <T>() => sealPlain({} as T)

vi.mock('../sync/scheduler', () => ({ stopScheduler: vi.fn() }))
vi.mock('../sync/engine', () => ({ syncAccount: vi.fn() }))

const MINE = 'account-1'
const OTHER = 'account-2'

/** One row in every per-account table, for two different accounts. */
async function seed() {
  for (const accountId of [MINE, OTHER]) {
    await db.accounts.put({
      id: accountId,
      provider: 'jmap',
      encrypted: false,
      payload: stub(),
    })
    await db.syncState.put({ accountId, collection: 'email', state: 's', updatedAt: 0 })
    await db.mailboxes.put({
      accountId,
      id: 'm',
      role: null,
      parentId: null,
      sortOrder: 0,
      payload: stub(),
    })
    await db.emails.put({
      accountId,
      id: 'e',
      threadId: 't',
      receivedAt: 0,
      mailboxIds: ['m'],
      unread: 0,
      flagged: 0,
      payload: stub(),
    })
    await db.threads.put({ accountId, id: 't', latestAt: 0, payload: stub() })
    await db.bodyCache.put({ accountId, emailId: 'e', lastAccess: 0, payload: stub() })
    await db.blobCache.put({ accountId, blobId: 'b', size: 1, lastAccess: 0, payload: stub() })
    await db.outbox.add({
      accountId,
      kind: 'email.update',
      status: 'pending',
      attempts: 0,
      notBefore: 0,
      payload: stub(),
    })
    await db.addressBooks.put({ accountId, id: 'ab', payload: stub() })
    await db.contacts.put({
      accountId,
      id: 'c',
      addressBookIds: ['ab'],
      sortKey: 'a',
      payload: stub(),
    })
    await db.calendars.put({ accountId, id: 'cal', payload: stub() })
    await db.events.put({ accountId, id: 'ev', calendarIds: ['cal'], payload: stub() })
  }
}

const perAccount = () => [
  db.syncState,
  db.mailboxes,
  db.emails,
  db.threads,
  db.bodyCache,
  db.blobCache,
  db.outbox,
  db.addressBooks,
  db.contacts,
  db.calendars,
  db.events,
]

describe('removeAccount', () => {
  beforeEach(async () => {
    await Promise.all([db.accounts, db.keyring, ...perAccount()].map((tbl) => tbl.clear()))
    await seed()
  })

  it('leaves nothing of the account behind', async () => {
    await removeAccount(MINE)

    expect(await db.accounts.get(MINE)).toBeUndefined()
    for (const table of perAccount()) {
      // Contacts, calendars and events were missing from this list once, so a
      // "logout" left the previous user's data readable on the device.
      const left = await table.where('accountId').equals(MINE).count()
      expect(`${table.name}: ${left}`).toBe(`${table.name}: 0`)
    }
  })

  it('does not touch a second account on the same device', async () => {
    await removeAccount(MINE)

    expect(await db.accounts.get(OTHER)).toBeDefined()
    for (const table of perAccount()) {
      const left = await table.where('accountId').equals(OTHER).count()
      expect(`${table.name}: ${left}`).toBe(`${table.name}: 1`)
    }
  })
})
