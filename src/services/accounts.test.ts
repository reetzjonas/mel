import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Credentials } from '../domain/account'
import { JmapError } from '../providers/jmap/client/transport'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import {
  NoServerFound,
  addAccount,
  refreshCapabilities,
  removeAccount,
  resyncAccount,
  signOut,
} from './accounts'

// These rows only need their index columns to be real; the sealed payloads are
// never opened here, so a stub stands in for each row's full domain object.
const stub = <T>() => sealPlain({} as T)

/** Everything the module reaches for, in the order it was reached for. */
const order: string[] = []
/** The candidate URLs connect() was tried against. */
const attempts: string[] = []

/** What connect() does for a given candidate URL; a test may replace it. */
let connectTo: (server: string) => Promise<{ account: Account }> = (server) =>
  Promise.resolve({ account: { id: 'x', label: server } as Account })

vi.mock('../providers/registry', () => ({
  providerFor: () => ({
    connect: (server: string, _creds: Credentials, localId: string) => {
      attempts.push(server)
      return connectTo(server).then((c) => ({ ...c, account: { ...c.account, id: localId } }))
    },
  }),
}))

vi.mock('../sync/scheduler', () => ({ stopScheduler: () => void order.push('stopScheduler') }))
vi.mock('../sync/engine', () => ({
  syncAccount: () => void order.push('syncAccount'),
  syncSettled: () => void order.push('syncSettled'),
}))
vi.mock('../sync/connections', () => ({
  connectionFor: () => {
    order.push('connectionFor')
    return Promise.resolve({ account: { id: 'acc', capabilities: { mail: true } } })
  },
  dropConnection: () => void order.push('dropConnection'),
}))

const MINE = 'account-1'
const OTHER = 'account-2'

const creds: Credentials = { method: 'basic', username: 'alice', secret: 'pw' }

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
      mailboxDates: [],
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

const clearAll = () =>
  Promise.all([db.accounts, db.keyring, ...perAccount()].map((tbl) => tbl.clear()))

beforeEach(() => {
  order.length = 0
  attempts.length = 0
  connectTo = (server) => Promise.resolve({ account: { id: 'x', label: server } as Account })
})

describe('adding an account', () => {
  beforeEach(clearAll)

  it('takes the first candidate that answers, and stops looking', async () => {
    connectTo = (server) =>
      server.includes('mail.')
        ? Promise.reject(new JmapError('nope', 'network'))
        : Promise.resolve({ account: { id: 'x', label: server } as Account })

    const id = await addAccount(['https://mail.example.test', 'https://example.test'], creds)

    expect(attempts).toEqual(['https://mail.example.test', 'https://example.test'])
    expect(openEnvelope((await db.accounts.get(id))!.payload).account.label).toBe(
      'https://example.test',
    )
  })

  it('stops the walk the moment a server refuses the password', async () => {
    /*
     * A 401 means that server is the right one and the password is wrong.
     * Trying the remaining hosts would swap a useful error for a misleading
     * "no server found", and send someone hunting in the wrong place.
     */
    connectTo = () => Promise.reject(new JmapError('bad password', 'auth', undefined, 401))

    await expect(
      addAccount(['https://mail.example.test', 'https://example.test'], creds),
    ).rejects.toBeInstanceOf(JmapError)

    expect(attempts).toEqual(['https://mail.example.test'])
  })

  it('reports what it tried, and why the last one failed', async () => {
    // A browser cannot tell a CORS rejection from a DNS miss, so the reason is
    // kept verbatim rather than flattened into "not found".
    connectTo = () => Promise.reject(new JmapError('CORS', 'network'))

    const error = (await addAccount(['https://a.test', 'https://b.test'], creds).catch(
      (e: unknown) => e,
    )) as NoServerFound

    expect(error).toBeInstanceOf(NoServerFound)
    expect(error.tried).toEqual(['https://a.test', 'https://b.test'])
    expect(error.lastError).not.toBeNull()
    // And nothing half-written stays behind to be picked up as a real account.
    expect(await db.accounts.count()).toBe(0)
  })

  it('stores the credentials with the account, since nothing else holds them', async () => {
    // There is no backend: these live in IndexedDB or the account cannot be
    // opened again after a reload.
    const id = await addAccount(['https://example.test'], creds)

    expect(openEnvelope((await db.accounts.get(id))!.payload).credentials).toEqual(creds)
    // The first sync starts without being waited for, so the form can close.
    expect(order).toContain('syncAccount')
  })
})

describe('signing out', () => {
  beforeEach(async () => {
    await clearAll()
    await seed()
  })

  it('stops the sync before wiping, and waits for one already in flight', async () => {
    /*
     * The order is the whole fix. A tick already running holds a *cached*
     * connection and happily writes mail rows after the wipe, so signing out
     * mid-sync used to leave the previous user's mail on the device.
     */
    await signOut(MINE)

    expect(order).toEqual(['stopScheduler', 'dropConnection', 'syncSettled'])
    expect(await db.emails.where('accountId').equals(MINE).count()).toBe(0)
  })
})

describe('removeAccount', () => {
  beforeEach(async () => {
    await clearAll()
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

describe('re-reading what the server can do', () => {
  it('drops the cached connection first, so the answer is a fresh one', async () => {
    /*
     * This is the "I just switched it on, show me" button. Reusing the cached
     * connection would report what the session said at app start, so the
     * feature stays hidden until the next reload — which reads as the button
     * not working.
     */
    const account = await refreshCapabilities(MINE)

    expect(order).toEqual(['dropConnection', 'connectionFor'])
    expect(account.capabilities).toEqual({ mail: true })
  })
})

describe('fetching everything again', () => {
  beforeEach(async () => {
    await clearAll()
    await seed()
  })

  it('throws the sync cursors away, which is what makes the next pass a full one', async () => {
    /*
     * A delta sync can only carry changes forward; it cannot repair a mirror
     * that is missing rows, because the server never "changed" them. Dropping
     * the cursors both refills the gaps and prunes what the server no longer
     * has.
     */
    await resyncAccount(MINE)

    expect(await db.syncState.where('accountId').equals(MINE).count()).toBe(0)
    expect(order).toContain('syncAccount')
    // And only for that account.
    expect(await db.syncState.where('accountId').equals(OTHER).count()).toBe(1)
  })
})
