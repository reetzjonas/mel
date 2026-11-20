import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, AccountCapabilities, Credentials } from '../domain/account'
import type { ProviderConnection, ProviderSession } from '../providers/types'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { authorization, forgetAccessTokens } from '../providers/jmap/client/auth'
import { connectionFor, dropConnection, dropSession, storedAccount } from './connections'

const SESSION_ID = 'session-1'
const ACCOUNT_ID = 'account-1'

const caps = (over: Partial<AccountCapabilities> = {}): AccountCapabilities => ({
  mail: true,
  submission: true,
  contacts: false,
  calendars: false,
  calendarCreate: false,
  sieve: false,
  vacation: false,
  files: false,
  quota: false,
  push: 'poll',
  webPush: false,
  ...over,
})

const account = (capabilities: AccountCapabilities, over: Partial<Account> = {}): Account => ({
  id: ACCOUNT_ID,
  sessionId: SESSION_ID,
  provider: 'jmap',
  label: 'alice@example.test',
  remoteAccountId: 'remote-1',
  sessionUrl: 'https://example.test/.well-known/jmap',
  capabilities,
  encrypted: false,
  ...over,
})

const credentials: Credentials = { method: 'basic', username: 'alice', secret: 'hunter2' }

/** What the server says this time round; each openSession() reads it afresh. */
let served: AccountCapabilities = caps()
/** The accounts the session lists. */
let remotes: string[] = ['remote-1']

const openSession = vi.fn(
  async (sessionUrl: string, creds: Credentials, sessionId: string): Promise<ProviderSession> => {
    const listed = [...remotes]
    return {
      session: { id: sessionId, provider: 'jmap', sessionUrl, label: 'alice' },
      credentials: creds,
      accounts: listed,
      account: (forSession, localId, remoteAccountId): ProviderConnection => {
        if (!listed.includes(remoteAccountId)) throw new Error('gone')
        // The real provider rebuilds the account from the session rather than
        // echoing the stored one back, which is the whole point of this test.
        const built = account(served, { id: localId, sessionId: forSession, remoteAccountId })
        return {
          account: built,
          capabilities: served,
          mail: null,
          contacts: null,
          calendars: null,
          files: null,
          sieve: null,
          quota: null,
          push: { eventSourceUrl: 'https://example.test/events', credentials: creds },
        }
      },
    }
  },
)

vi.mock('../providers/registry', () => ({
  providerFor: () => ({ kind: 'jmap', openSession }),
}))

const storedCapabilities = async () => (await storedAccount(ACCOUNT_ID)).account.capabilities

async function seedSession(creds: Credentials = credentials) {
  await db.sessions.put({
    id: SESSION_ID,
    provider: 'jmap',
    encrypted: false,
    payload: sealPlain({
      session: {
        id: SESSION_ID,
        provider: 'jmap',
        sessionUrl: 'https://example.test/.well-known/jmap',
        label: 'alice',
      },
      credentials: creds,
    }),
  })
}

async function seedAccount(over: Partial<Account> = {}) {
  const a = account(caps({ submission: false, calendars: false }), over)
  await db.accounts.put({
    id: a.id,
    sessionId: a.sessionId,
    provider: 'jmap',
    encrypted: false,
    payload: sealPlain({ account: a }),
  })
}

beforeEach(async () => {
  openSession.mockClear()
  served = caps()
  remotes = ['remote-1']
  await dropSession(SESSION_ID)
  await dropSession(ACCOUNT_ID)
  dropConnection(ACCOUNT_ID)
  dropConnection('account-2')
  await db.accounts.clear()
  await db.sessions.clear()
})

describe('connectionFor', () => {
  beforeEach(async () => {
    await seedSession()
    // Stored as it was at login: no calendar, sending not offered.
    await seedAccount()
  })

  it('stores what the fresh session reports, not what login saw', async () => {
    served = caps({ submission: true, calendars: true })

    await connectionFor(ACCOUNT_ID)

    expect(await storedCapabilities()).toMatchObject({ submission: true, calendars: true })
  })

  it('takes the credentials from the session, and keeps none on the account', async () => {
    await connectionFor(ACCOUNT_ID)

    expect((await storedAccount(ACCOUNT_ID)).credentials).toEqual(credentials)
    expect(openEnvelope((await db.accounts.get(ACCOUNT_ID))!.payload).credentials).toBeUndefined()
  })

  it('opens once and reuses the connection until it is dropped', async () => {
    await connectionFor(ACCOUNT_ID)
    await connectionFor(ACCOUNT_ID)
    expect(openSession).toHaveBeenCalledTimes(1)

    await dropSession(SESSION_ID)
    await connectionFor(ACCOUNT_ID)
    expect(openSession).toHaveBeenCalledTimes(2)
  })

  it('does not resurrect an account that was signed out while connecting', async () => {
    const pending = connectionFor(ACCOUNT_ID)
    await db.accounts.delete(ACCOUNT_ID)
    await pending.catch(() => {})

    expect(await db.accounts.get(ACCOUNT_ID)).toBeUndefined()
  })

  it('still hands back a usable connection when the write fails', async () => {
    const put = vi.spyOn(db.accounts, 'put').mockRejectedValue(new Error('disk full'))

    await expect(connectionFor(ACCOUNT_ID)).resolves.toBeDefined()

    put.mockRestore()
  })

  it('fails, rather than showing another account, for one the session no longer lists', async () => {
    remotes = ['remote-9']

    await expect(connectionFor(ACCOUNT_ID)).rejects.toThrow('gone')
    expect(await db.accounts.get(ACCOUNT_ID)).toBeDefined()
  })
})

describe('several accounts behind one login', () => {
  beforeEach(async () => {
    remotes = ['remote-1', 'remote-2']
    await seedSession()
    await seedAccount()
    await seedAccount({ id: 'account-2', remoteAccountId: 'remote-2' })
  })

  it('fetch the session once, and share its credentials object', async () => {
    const one = await connectionFor(ACCOUNT_ID)
    const two = await connectionFor('account-2')

    expect(openSession).toHaveBeenCalledTimes(1)
    // One object, so a token renewed through either is the other's at once.
    expect(one.push!.credentials).toBe(two.push!.credentials)
    expect(two.account.remoteAccountId).toBe('remote-2')
  })
})

describe('an account the session has gained', () => {
  beforeEach(async () => {
    await seedSession()
    await seedAccount()
  })

  it('is added the next time the session is opened', async () => {
    remotes = ['remote-1', 'remote-3']

    await connectionFor(ACCOUNT_ID)

    const added = (await db.accounts.where('sessionId').equals(SESSION_ID).toArray())
      .map((r) => openEnvelope(r.payload).account.remoteAccountId)
      .sort()
    expect(added).toEqual(['remote-1', 'remote-3'])
  })

  it('is not added to a session signed out while it was opening', async () => {
    remotes = ['remote-1', 'remote-3']
    openSession.mockImplementationOnce(async (...args) => {
      await db.sessions.delete(SESSION_ID)
      return openSession.getMockImplementation()!(...args)
    })

    await connectionFor(ACCOUNT_ID).catch(() => {})

    expect(await db.accounts.where('sessionId').equals(SESSION_ID).count()).toBe(1)
  })
})

describe('an account from before sessions', () => {
  it('becomes its own session, under its own id, the first time it is used', async () => {
    const legacy = account(caps(), { sessionId: undefined as unknown as string })
    await db.accounts.put({
      id: ACCOUNT_ID,
      provider: 'jmap',
      encrypted: false,
      pushDetails: true,
      payload: sealPlain({ account: legacy, credentials }),
    })

    await connectionFor(ACCOUNT_ID)

    const session = await db.sessions.get(ACCOUNT_ID)
    expect(session?.pushDetails).toBe(true)
    expect(openEnvelope(session!.payload).credentials).toEqual(credentials)
    const row = await db.accounts.get(ACCOUNT_ID)
    expect(row?.sessionId).toBe(ACCOUNT_ID)
    expect(openEnvelope(row!.payload).credentials).toBeUndefined()
  })
})

describe('a refresh token the server replaced', () => {
  it('is stored in place of the old one, on the session', async () => {
    const tokens: Credentials = {
      method: 'oauth',
      username: 'alice',
      secret: 'refresh-1',
      tokenEndpoint: 'https://example.test/auth/token',
    }
    await seedSession(tokens)
    await seedAccount()
    forgetAccessTokens()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ access_token: 'a', expires_in: 3600, refresh_token: 'refresh-2' }),
      ),
    )

    try {
      await authorization({ ...tokens })
      await vi.waitFor(async () =>
        expect((await storedAccount(ACCOUNT_ID)).credentials.secret).toBe('refresh-2'),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
