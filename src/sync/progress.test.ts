import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailHeader } from '../domain/email'
import type { MailProvider } from '../providers/types'
import { db } from '../storage/db'
import { getFullSyncProgress, setFullSyncProgress, subscribeFullSync } from './progress'

const ACCOUNT = 'account-1'

describe('the full-sync progress store', () => {
  beforeEach(() => setFullSyncProgress(ACCOUNT, null))

  it('is null when nothing is fetching, and says so by identity', () => {
    // useSyncExternalStore compares snapshots by identity: a fresh object per
    // read would re-render forever.
    expect(getFullSyncProgress(ACCOUNT)).toBeNull()
    expect(getFullSyncProgress(ACCOUNT)).toBe(getFullSyncProgress(ACCOUNT))

    setFullSyncProgress(ACCOUNT, { done: 10, total: 100 })
    expect(getFullSyncProgress(ACCOUNT)).toBe(getFullSyncProgress(ACCOUNT))
  })

  it('tells subscribers only when the numbers actually move', () => {
    const seen = vi.fn()
    const stop = subscribeFullSync(seen)

    setFullSyncProgress(ACCOUNT, { done: 10, total: 100 })
    setFullSyncProgress(ACCOUNT, { done: 10, total: 100 })
    expect(seen).toHaveBeenCalledTimes(1)

    setFullSyncProgress(ACCOUNT, { done: 20, total: 100 })
    expect(seen).toHaveBeenCalledTimes(2)

    setFullSyncProgress(ACCOUNT, null)
    setFullSyncProgress(ACCOUNT, null)
    expect(seen).toHaveBeenCalledTimes(3)
    stop()
  })

  it('keeps accounts apart', () => {
    setFullSyncProgress(ACCOUNT, { done: 5, total: 50 })
    expect(getFullSyncProgress('account-2')).toBeNull()
  })
})

const header = (id: string): EmailHeader =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: {},
    from: [],
    to: [],
    cc: [],
    bcc: [],
    subject: id,
    preview: '',
    receivedAt: 0,
    hasAttachment: false,
    attachments: [],
    messageId: [],
    references: [],
  }) as unknown as EmailHeader

/** A provider whose full fetch hands over three pages, then stops. */
type OnPage = Parameters<MailProvider['listAllEmailHeaders']>[0]

function pagingProvider(pages: string[][], total: number | null, onPageStart?: () => void) {
  return {
    async listAllEmailHeaders(onPage: OnPage) {
      for (const ids of pages) {
        onPageStart?.()
        await onPage({ headers: ids.map(header), state: 's', total })
      }
      return 's'
    },
    syncMailboxes: async () => ({
      created: [],
      updated: [],
      destroyedIds: [],
      newState: 'm',
      hasMore: false,
    }),
  } as unknown as MailProvider
}

vi.mock('./connections', () => ({
  connectionFor: () => Promise.resolve(connection),
}))

let connection: { mail: MailProvider | null; contacts: null; calendars: null }

describe('the first full fetch, as the UI sees it', () => {
  // syncAccount takes a Web Lock so two tabs cannot sync the same account at
  // once; jsdom has no navigator.locks, so the test runs the body directly.
  beforeAll(() => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: (_name: string, fn: () => Promise<void>) => fn() },
    })
  })

  beforeEach(async () => {
    setFullSyncProgress(ACCOUNT, null)
    await db.emails.where('accountId').equals(ACCOUNT).delete()
    await db.syncState.where('accountId').equals(ACCOUNT).delete()
  })

  it('reports a count before the first page, and grows it as pages land', async () => {
    const seen: Array<{ done: number; total: number | null } | null> = []
    const stop = subscribeFullSync(() => seen.push(getFullSyncProgress(ACCOUNT)))
    connection = {
      mail: pagingProvider([['a', 'b'], ['c']], 3),
      contacts: null,
      calendars: null,
    }

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)
    stop()

    // Starts at zero *before* the first request, which on a large mailbox is
    // the longest wait of the lot and used to show an empty folder.
    expect(seen[0]).toEqual({ done: 0, total: null })
    expect(seen.slice(1, -1)).toEqual([
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ])
    // And is cleared at the end, or the UI would claim it is still fetching.
    expect(seen.at(-1)).toBeNull()
    expect(getFullSyncProgress(ACCOUNT)).toBeNull()
  })

  it('clears the count when the fetch gives up half way', async () => {
    connection = {
      mail: {
        async listAllEmailHeaders(onPage: OnPage) {
          await onPage({ headers: [header('a')], state: 's', total: 9 })
          throw new Error('connection lost')
        },
        syncMailboxes: async () => ({
          created: [],
          updated: [],
          destroyedIds: [],
          newState: 'm',
          hasMore: false,
        }),
      } as unknown as MailProvider,
      contacts: null,
      calendars: null,
    }

    const { syncAccount } = await import('./engine')
    await expect(syncAccount(ACCOUNT)).rejects.toThrow('connection lost')

    // A progress line left standing would claim a fetch is still running.
    expect(getFullSyncProgress(ACCOUNT)).toBeNull()
  })
})
