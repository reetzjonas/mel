import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Credentials } from '../domain/account'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { mailNotificationFor } from './mailNotification'

const ACC = 'local-1'
const REMOTE = 'remote-1'

const account = {
  id: ACC,
  provider: 'jmap',
  label: 'a@test',
  remoteAccountId: REMOTE,
  sessionUrl: 'https://jmap.test/.well-known/jmap',
  encrypted: false,
  capabilities: {},
} as unknown as Account

const credentials: Credentials = { method: 'basic', username: 'a', secret: 'b' }

/** The JMAP request the last run sent, for asserting on the filter. */
let lastRequest: { using: string[]; methodCalls: Array<[string, Record<string, unknown>, string]> }
/** What Email/get answers with. */
let list: Array<{ subject?: string; from?: Array<{ name?: string | null; email: string }> }> = []

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if (!init?.method)
        return Promise.resolve(
          new Response(JSON.stringify({ apiUrl: 'https://jmap.test/api' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      lastRequest = JSON.parse(String(init.body))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            methodResponses: [
              ['Email/query', { ids: list.length ? ['e1'] : [] }, 'q'],
              ['Email/get', { list }, 'g'],
            ],
            sessionState: 's',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }),
  )
}

async function seed(row: Partial<{ encrypted: boolean; pushDetails: boolean }> = {}) {
  await db.accounts.put({
    id: ACC,
    provider: 'jmap',
    encrypted: false,
    pushDetails: true,
    ...row,
    payload: sealPlain({ account, credentials }),
  })
  await db.mailboxes.put({
    accountId: ACC,
    id: 'mb-inbox',
    parentId: null,
    role: 'inbox',
    sortOrder: 0,
    payload: sealPlain({ id: 'mb-inbox', name: 'Inbox' } as never),
  })
}

describe('mailNotificationFor', () => {
  beforeEach(async () => {
    await db.accounts.clear()
    await db.mailboxes.clear()
    list = [{ subject: 'Lunch?', from: [{ name: 'Bob', email: 'bob@test' }] }]
    mockFetch()
  })

  it('names the sender and subject of the newest unread inbox message', async () => {
    await seed()
    expect(await mailNotificationFor(REMOTE)).toEqual({ title: 'Bob', body: 'Lunch?' })
    // The local mailbox list answers which mailbox is the inbox, so the
    // notification costs no extra Mailbox/query.
    expect(lastRequest.methodCalls[0]?.[1]['filter']).toEqual({
      inMailbox: 'mb-inbox',
      notKeyword: '$seen',
    })
  })

  it('falls back to the sender address when the card carries no name', async () => {
    await seed()
    list = [{ subject: 'Hi', from: [{ email: 'bob@test' }] }]
    expect(await mailNotificationFor(REMOTE)).toEqual({ title: 'bob@test', body: 'Hi' })
  })

  it('says nothing for an account that has not opted in', async () => {
    await seed({ pushDetails: false })
    expect(await mailNotificationFor(REMOTE)).toBeNull()
  })

  it('says nothing for an encrypted account, whatever the flag says', async () => {
    await seed({ encrypted: true })
    expect(await mailNotificationFor(REMOTE)).toBeNull()
  })

  it('says nothing for an account this device does not have', async () => {
    await seed()
    expect(await mailNotificationFor('someone-else')).toBeNull()
  })

  it('says nothing when the inbox holds nothing unread', async () => {
    await seed()
    list = []
    expect(await mailNotificationFor(REMOTE)).toBeNull()
  })

  it('says nothing rather than throwing when the server refuses', async () => {
    await seed()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 401 }))),
    )
    expect(await mailNotificationFor(REMOTE)).toBeNull()
  })
})
