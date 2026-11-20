import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Credentials } from '../domain/account'
import type { ProviderSession } from '../providers/types'
import { JmapError } from '../providers/jmap/client/transport'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { TotpRequired } from '../providers/jmap/client/auth'
import {
  NoServerFound,
  addAccount,
  reauthenticate,
  refreshCapabilities,
  removeAccount,
  resyncAccount,
  signOut,
  upgradeToTokens,
} from './accounts'

// These rows only need their index columns to be real; the sealed payloads are
// never opened here, so a stub stands in for each row's full domain object.
const stub = <T>() => sealPlain({} as T)

/** Everything the module reaches for, in the order it was reached for. */
const order: string[] = []
/** The candidate servers a session was opened on. */
const attempts: string[] = []

/** The accounts the session lists, by the server's ids. */
let listed: string[] = ['r1']

/** A session on `server`, reaching the accounts in `listed`. */
const sessionOn = (server: string, credentials: Credentials, sessionId: string) =>
  ({
    session: { id: sessionId, provider: 'jmap', sessionUrl: server, label: 'alice' },
    credentials,
    accounts: [...listed],
    account: (forSession: string, id: string, remoteAccountId: string) => ({
      account: {
        id,
        sessionId: forSession,
        provider: 'jmap',
        label: `${remoteAccountId}@${server}`,
        remoteAccountId,
        sessionUrl: server,
      } as Account,
    }),
  }) as unknown as ProviderSession

/** What opening a session does for a given candidate; a test may replace it. */
let openOn: (server: string) => Promise<void> = () => Promise.resolve()

vi.mock('../providers/registry', () => ({
  providerFor: () => ({
    openSession: (sessionUrl: string, credentials: Credentials, sessionId: string) => {
      const server = sessionUrl.replace(/\/\.well-known\/jmap$/, '')
      attempts.push(server)
      return openOn(server).then(() => sessionOn(server, credentials, sessionId))
    },
  }),
}))

/** What the server's token login answers; null is a server without one. */
let tokenLoginAnswer: (password: string, totp?: string) => Promise<Credentials | null> = () =>
  Promise.resolve(null)
/** What the session check makes of credentials handed to it. */
let sessionAccepts: (creds: Credentials) => boolean = () => true

vi.mock('../providers/jmap/client/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/jmap/client/auth')>()),
  tokenLogin: (p: { password: string; totp?: string }) => tokenLoginAnswer(p.password, p.totp),
}))
vi.mock('../providers/jmap/client/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/jmap/client/session')>()),
  fetchSession: (_url: string, c: Credentials) =>
    sessionAccepts(c)
      ? Promise.resolve({})
      : Promise.reject(new JmapError('refused', 'auth', undefined, 401)),
}))

vi.mock('../sync/scheduler', () => ({
  stopScheduler: () => void order.push('stopScheduler'),
  startScheduler: () => void order.push('startScheduler'),
}))
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
  dropSession: async () => void order.push('dropSession'),
}))

const MINE = 'account-1'
const OTHER = 'account-2'

const creds: Credentials = { method: 'basic', username: 'alice', secret: 'pw' }

/** One row in every per-account table, for two different accounts. */
async function seed() {
  for (const accountId of [MINE, OTHER]) {
    await db.accounts.put({
      id: accountId,
      // Each its own session, as every account from before sessions is.
      sessionId: accountId,
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
    await db.eventNotifications.put({ accountId, id: 'n', payload: stub() })
    await db.submissions.put({ accountId, id: 's', emailId: 'e', payload: stub() })
    await db.pgpKeys.put({ accountId, fingerprint: 'f', payload: stub() })
    await db.files.put({
      accountId,
      id: 'f',
      parentKey: '',
      nodeType: 'file',
      payload: stub(),
    })
    await db.notes.put({ accountId, id: 'note', pinned: 0, modified: '', payload: stub() })
    await db.imageSenders.put({ accountId, payload: stub() })
  }
}

/**
 * Every table that holds an account's data — all of them but the account list
 * and its keyring, which removeAccount empties by their own key.
 *
 * Read off the database rather than listed by hand: the hand-written list here
 * and the one in removeAccount went stale together, first for contacts and
 * calendars, then for files and notes, and a test that names the same tables
 * as the code can only ever agree with it. A new table has to be seeded in
 * `seed()` or the second test below fails.
 */
const perAccount = () =>
  db.tables.filter(
    (tbl) => tbl.name !== 'accounts' && tbl.name !== 'keyring' && tbl.name !== 'sessions',
  )

const clearAll = () =>
  Promise.all([db.sessions, db.accounts, db.keyring, ...perAccount()].map((tbl) => tbl.clear()))

/** The credentials stored for the session an account is reached through. */
const credentialsOf = async (accountId: string) => {
  const row = await db.accounts.get(accountId)
  const session = await db.sessions.get(row!.sessionId!)
  return openEnvelope(session!.payload).credentials
}

beforeEach(() => {
  order.length = 0
  attempts.length = 0
  listed = ['r1']
  openOn = () => Promise.resolve()
  tokenLoginAnswer = () => Promise.resolve(null)
  sessionAccepts = () => true
})

const tokens: Credentials = {
  method: 'oauth',
  username: 'alice',
  secret: 'refresh-1',
  tokenEndpoint: 'https://example.test/auth/token',
  clientId: 'mel',
}

describe('adding an account', () => {
  beforeEach(clearAll)

  it('takes the first candidate that answers, and stops looking', async () => {
    openOn = (server) =>
      server.includes('mail.')
        ? Promise.reject(new JmapError('nope', 'network'))
        : Promise.resolve()

    const id = await addAccount(['https://mail.example.test', 'https://example.test'], creds)

    expect(attempts).toEqual(['https://mail.example.test', 'https://example.test'])
    expect(openEnvelope((await db.accounts.get(id))!.payload).account.label).toBe(
      'r1@https://example.test',
    )
  })

  it('stops the walk the moment a server refuses the password', async () => {
    /*
     * A 401 means that server is the right one and the password is wrong.
     * Trying the remaining hosts would swap a useful error for a misleading
     * "no server found", and send someone hunting in the wrong place.
     */
    openOn = () => Promise.reject(new JmapError('bad password', 'auth', undefined, 401))

    await expect(
      addAccount(['https://mail.example.test', 'https://example.test'], creds),
    ).rejects.toBeInstanceOf(JmapError)

    expect(attempts).toEqual(['https://mail.example.test'])
  })

  it('reports what it tried, and why the last one failed', async () => {
    // A browser cannot tell a CORS rejection from a DNS miss, so the reason is
    // kept verbatim rather than flattened into "not found".
    openOn = () => Promise.reject(new JmapError('CORS', 'network'))

    const error = (await addAccount(['https://a.test', 'https://b.test'], creds).catch(
      (e: unknown) => e,
    )) as NoServerFound

    expect(error).toBeInstanceOf(NoServerFound)
    expect(error.tried).toEqual(['https://a.test', 'https://b.test'])
    expect(error.lastError).not.toBeNull()
    // And nothing half-written stays behind to be picked up as a real account.
    expect(await db.accounts.count()).toBe(0)
    expect(await db.sessions.count()).toBe(0)
  })

  it('stores the credentials with the session, since nothing else holds them', async () => {
    // There is no backend: these live in IndexedDB or the account cannot be
    // opened again after a reload.
    const id = await addAccount(['https://example.test'], creds)

    expect(await credentialsOf(id)).toEqual(creds)
    expect(openEnvelope((await db.accounts.get(id))!.payload).credentials).toBeUndefined()
    // The first sync starts without being waited for, so the form can close.
    expect(order).toContain('syncAccount')
  })

  it('adds every account the login reaches, under one session, and shows the primary', async () => {
    listed = ['primary', 'shared']

    const id = await addAccount(['https://example.test'], creds)

    const rows = await db.accounts.toArray()
    expect(rows.map((r) => openEnvelope(r.payload).account.remoteAccountId).sort()).toEqual([
      'primary',
      'shared',
    ])
    expect(new Set(rows.map((r) => r.sessionId)).size).toBe(1)
    expect(await db.sessions.count()).toBe(1)
    expect(openEnvelope((await db.accounts.get(id))!.payload).account.remoteAccountId).toBe(
      'primary',
    )
  })

  it('signs the same login in again as the session it is, adding only what is new', async () => {
    const first = await addAccount(['https://example.test'], creds)
    listed = ['r1', 'r2']
    const fresh = { ...creds, secret: 'new-pw' }

    const again = await addAccount(['https://example.test'], fresh)

    expect(again).toBe(first)
    expect(await db.sessions.count()).toBe(1)
    expect(await db.accounts.count()).toBe(2)
    expect(await credentialsOf(first)).toEqual(fresh)
  })
})

describe('signing in with a token instead of a stored password', () => {
  beforeEach(clearAll)

  const account = {
    id: MINE,
    sessionId: MINE,
    label: 'alice',
    sessionUrl: 'https://example.test/jmap',
  }
  const seedAccount = async (credentials: Credentials) => {
    await db.sessions.put({
      id: MINE,
      provider: 'jmap',
      encrypted: false,
      payload: sealPlain({
        session: { id: MINE, provider: 'jmap', sessionUrl: account.sessionUrl, label: 'alice' },
        credentials,
      }),
    })
    await db.accounts.put({
      id: MINE,
      sessionId: MINE,
      provider: 'jmap',
      encrypted: false,
      payload: sealPlain({ account: account as Account }),
    })
  }
  const stored = () => credentialsOf(MINE)

  it('stores the refresh token, not the password, where the server offers one', async () => {
    tokenLoginAnswer = (password) => Promise.resolve(password === 'pw' ? tokens : null)

    const id = await addAccount(['https://example.test'], creds)

    expect(await credentialsOf(id)).toEqual(tokens)
  })

  it('hands a request for a code back to the form without trying other hosts', async () => {
    tokenLoginAnswer = () => Promise.reject(new TotpRequired())

    await expect(
      addAccount(['https://mail.example.test', 'https://example.test'], creds),
    ).rejects.toBeInstanceOf(TotpRequired)
    expect(attempts).toEqual([])

    tokenLoginAnswer = (_pw, totp) => Promise.resolve(totp === '123456' ? tokens : null)
    const id = await addAccount(['https://example.test'], creds, '123456')
    expect(await credentialsOf(id)).toEqual(tokens)
  })

  it('swaps an existing account’s stored password for a token once', async () => {
    await seedAccount(creds)
    tokenLoginAnswer = () => Promise.resolve(tokens)

    await upgradeToTokens(MINE)

    expect(await stored()).toEqual(tokens)
    expect(order).toContain('dropSession')
  })

  it('leaves the password where the swap cannot happen', async () => {
    // No token login on the server, a code it would need, no network: Basic
    // keeps working as it did, and nobody is signed out over it.
    await seedAccount(creds)
    for (const answer of [
      () => Promise.resolve(null),
      () => Promise.reject(new TotpRequired()),
      () => Promise.reject(new TypeError('Failed to fetch')),
    ]) {
      tokenLoginAnswer = answer
      await upgradeToTokens(MINE)
      expect(await stored()).toEqual(creds)
    }
  })

  it('signs in again with a password, restarting the sync on the new credentials', async () => {
    await seedAccount({ ...tokens, secret: 'expired' })
    tokenLoginAnswer = (password) => Promise.resolve(password === 'new-pw' ? tokens : null)

    await reauthenticate(MINE, 'new-pw')

    expect(await stored()).toEqual(tokens)
    expect(order.slice(-3)).toEqual(['stopScheduler', 'dropSession', 'startScheduler'])
  })

  it('keeps what was stored when the new password is refused too', async () => {
    const expired = { ...tokens, secret: 'expired' }
    await seedAccount(expired)
    sessionAccepts = () => false

    await expect(reauthenticate(MINE, 'typo')).rejects.toMatchObject({ kind: 'auth' })

    expect(await stored()).toEqual(expired)
    expect(order).not.toContain('startScheduler')
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

    expect(order).toEqual(['stopScheduler', 'dropSession', 'dropConnection', 'syncSettled'])
    expect(await db.emails.where('accountId').equals(MINE).count()).toBe(0)
  })

  it('takes every account of the login with it, and no other login’s', async () => {
    await db.accounts.update(OTHER, { sessionId: 'elsewhere' })
    await db.accounts.put({
      id: 'mine-too',
      sessionId: MINE,
      provider: 'jmap',
      encrypted: false,
      payload: stub(),
    })
    await db.sessions.put({ id: MINE, provider: 'jmap', encrypted: false, payload: stub() })

    await signOut(MINE)

    expect(await db.sessions.get(MINE)).toBeUndefined()
    expect(await db.accounts.get('mine-too')).toBeUndefined()
    expect(await db.accounts.get(OTHER)).toBeDefined()
    expect(await db.emails.where('accountId').equals(OTHER).count()).toBe(1)
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
      // Contacts, calendars, events, files and notes were each missing from the
      // code once, so a "logout" left the previous user's data on the device.
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

    expect(order).toEqual(['dropSession', 'connectionFor'])
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
