import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, AccountCapabilities, Credentials } from '../domain/account'
import type { ProviderConnection } from '../providers/types'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { connectionFor, dropConnection, storedAccount } from './connections'

const ACCOUNT_ID = 'account-1'

const caps = (over: Partial<AccountCapabilities> = {}): AccountCapabilities => ({
  mail: true,
  submission: true,
  contacts: false,
  calendars: false,
  sieve: false,
  vacation: false,
  push: 'poll',
  webPush: false,
  ...over,
})

const account = (capabilities: AccountCapabilities): Account => ({
  id: ACCOUNT_ID,
  provider: 'jmap',
  label: 'alice@example.test',
  remoteAccountId: 'remote-1',
  sessionUrl: 'https://example.test/.well-known/jmap',
  capabilities,
  encrypted: false,
})

const credentials: Credentials = { method: 'basic', username: 'alice', secret: 'hunter2' }

/** What the server says this time round; each open() reads it afresh. */
let served: AccountCapabilities = caps()
const open = vi.fn((stored: Account): Promise<ProviderConnection> =>
  Promise.resolve({
    // The real provider rebuilds the account from the session rather than
    // echoing the stored one back, which is the whole point of this test.
    account: { ...stored, capabilities: served },
    capabilities: served,
    mail: null,
    contacts: null,
    calendars: null,
    push: null,
  }),
)

vi.mock('../providers/registry', () => ({
  providerFor: () => ({ kind: 'jmap', open, connect: vi.fn() }),
}))

const storedCapabilities = async () => (await storedAccount(ACCOUNT_ID)).account.capabilities

describe('connectionFor', () => {
  beforeEach(async () => {
    open.mockClear()
    served = caps()
    dropConnection(ACCOUNT_ID)
    await db.accounts.clear()
    // Stored as it was at login: no calendar, sending not offered.
    await db.accounts.put({
      id: ACCOUNT_ID,
      provider: 'jmap',
      encrypted: false,
      payload: sealPlain({
        account: account(caps({ submission: false, calendars: false })),
        credentials,
      }),
    })
  })

  it('stores what the fresh session reports, not what login saw', async () => {
    served = caps({ submission: true, calendars: true })

    await connectionFor(ACCOUNT_ID)

    expect(await storedCapabilities()).toMatchObject({ submission: true, calendars: true })
  })

  it('keeps the credentials and the row flags the account already had', async () => {
    await db.accounts.update(ACCOUNT_ID, { encrypted: true })

    await connectionFor(ACCOUNT_ID)

    const row = await db.accounts.get(ACCOUNT_ID)
    expect(row?.encrypted).toBe(true)
    expect(openEnvelope(row!.payload).credentials).toEqual(credentials)
  })

  it('opens once and reuses the connection until it is dropped', async () => {
    await connectionFor(ACCOUNT_ID)
    await connectionFor(ACCOUNT_ID)
    expect(open).toHaveBeenCalledTimes(1)

    dropConnection(ACCOUNT_ID)
    await connectionFor(ACCOUNT_ID)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('does not resurrect an account that was signed out while connecting', async () => {
    const pending = connectionFor(ACCOUNT_ID)
    await db.accounts.delete(ACCOUNT_ID)
    await pending

    expect(await db.accounts.get(ACCOUNT_ID)).toBeUndefined()
  })

  it('still hands back a usable connection when the write fails', async () => {
    const put = vi.spyOn(db.accounts, 'put').mockRejectedValue(new Error('disk full'))

    await expect(connectionFor(ACCOUNT_ID)).resolves.toBeDefined()

    put.mockRestore()
  })
})
