import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailHeader } from '../domain/email'
import type { Mailbox } from '../domain/mailbox'
import { CannotCalculateChanges, type MailProvider, type SyncPage } from '../providers/types'
import { db } from '../storage/db'
import { openEnvelope } from '../storage/envelope'

const ACCOUNT = 'account-1'

const header = (id: string, over: Partial<EmailHeader> = {}): EmailHeader =>
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
    receivedAt: '2026-09-09T10:00:00Z',
    hasAttachment: false,
    attachments: [],
    ...over,
  }) as unknown as EmailHeader

const mailbox = (id: string, name = id): Mailbox =>
  ({
    id,
    name,
    role: null,
    parentId: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    mayAddItems: true,
    mayRename: true,
    mayDelete: true,
    mayCreateChild: true,
  }) as unknown as Mailbox

const page = <T>(over: Partial<SyncPage<T>> = {}): SyncPage<T> => ({
  created: [],
  updated: [],
  destroyedIds: [],
  newState: 'state-1',
  hasMore: false,
  ...over,
})

/** The provider the engine talks to; each test supplies the parts it needs. */
let mail: Partial<MailProvider>

vi.mock('./connections', () => ({
  connectionFor: () => Promise.resolve({ mail, contacts: null, calendars: null }),
}))

const storedState = async (collection: string) =>
  (await db.syncState.get([ACCOUNT, collection]))?.state

const storedEmailIds = async () =>
  (await db.emails.where('accountId').equals(ACCOUNT).toArray()).map((r) => r.id).sort()

describe('delta sync', () => {
  beforeAll(() => {
    // syncAccount takes a Web Lock so two tabs cannot sync at once; jsdom has
    // no navigator.locks, so the body runs directly.
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: (_name: string, fn: () => Promise<void>) => fn() },
    })
  })

  beforeEach(async () => {
    await db.emails.where('accountId').equals(ACCOUNT).delete()
    await db.mailboxes.where('accountId').equals(ACCOUNT).delete()
    await db.syncState.where('accountId').equals(ACCOUNT).delete()
  })

  it('applies a page of changes and remembers where it got to', async () => {
    // The stored state is what makes the next sync a delta rather than a
    // whole mailbox: losing it costs a full refetch of every message.
    await db.syncState.put({ accountId: ACCOUNT, collection: 'Email', state: 'old', updatedAt: 0 })
    await db.emails.bulkPut([
      {
        accountId: ACCOUNT,
        id: 'gone',
        threadId: 't',
        receivedAt: 0,
        mailboxIds: ['inbox'],
        mailboxDates: [],
        unread: 0,
        flagged: 0,
        payload: { plain: header('gone') },
      },
    ] as never)
    mail = {
      syncMailboxes: () => Promise.resolve(page<Mailbox>({ newState: 'm1' })),
      syncEmailHeaders: () =>
        Promise.resolve(
          page<EmailHeader>({ created: [header('new')], destroyedIds: ['gone'], newState: 'e2' }),
        ),
    }

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)

    expect(await storedEmailIds()).toEqual(['new'])
    expect(await storedState('Email')).toBe('e2')
  })

  it('keeps asking while the server says there is more', async () => {
    const pages = [
      page<EmailHeader>({ created: [header('a')], newState: 'e1', hasMore: true }),
      page<EmailHeader>({ created: [header('b')], newState: 'e2', hasMore: false }),
    ]
    const seen: string[] = []
    await db.syncState.put({ accountId: ACCOUNT, collection: 'Email', state: 'old', updatedAt: 0 })
    mail = {
      syncMailboxes: () => Promise.resolve(page<Mailbox>({ newState: 'm1' })),
      syncEmailHeaders: (since) => {
        seen.push(since)
        return Promise.resolve(pages.shift()!)
      },
    }

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)

    // The second request carries the state the first one returned, or the
    // same page would come back for ever.
    expect(seen).toEqual(['old', 'e1'])
    expect(await storedEmailIds()).toEqual(['a', 'b'])
  })

  it('refetches everything when the server has forgotten the state', async () => {
    /*
     * A server may drop the state it once handed out (Stalwart does after a
     * while). A delta sync cannot recover from that — the server never
     * "changed" the rows we are missing — so the only correct answer is to
     * fetch the whole mailbox again and prune what is no longer there.
     */
    await db.syncState.put({
      accountId: ACCOUNT,
      collection: 'Email',
      state: 'stale',
      updatedAt: 0,
    })
    await db.emails.bulkPut([
      {
        accountId: ACCOUNT,
        id: 'ancient',
        threadId: 't',
        receivedAt: 0,
        mailboxIds: ['inbox'],
        mailboxDates: [],
        unread: 0,
        flagged: 0,
        payload: { plain: header('ancient') },
      },
    ] as never)
    mail = {
      syncMailboxes: () => Promise.resolve(page<Mailbox>({ newState: 'm1' })),
      syncEmailHeaders: () => Promise.reject(new CannotCalculateChanges()),
      listAllEmailHeaders: async (onPage) => {
        await onPage({ headers: [header('fresh')], state: 'e9', total: 1 })
        return 'e9'
      },
    }

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)

    // The row the server no longer has is gone, not left behind for ever.
    expect(await storedEmailIds()).toEqual(['fresh'])
    expect(await storedState('Email')).toBe('e9')
  })

  it('drops mailboxes the server no longer has on a full fetch', async () => {
    // Only a full fetch can tell: a delta names what changed, so a folder
    // deleted while we were away is never mentioned again.
    await db.mailboxes.bulkPut([
      {
        accountId: ACCOUNT,
        id: 'deleted-elsewhere',
        parentId: null,
        role: null,
        sortOrder: 0,
        payload: { plain: mailbox('deleted-elsewhere') },
      },
    ] as never)
    mail = {
      syncMailboxes: () => Promise.resolve(page<Mailbox>({ created: [mailbox('inbox')] })),
      syncEmailHeaders: () => Promise.resolve(page<EmailHeader>()),
      listAllEmailHeaders: async () => 'e1',
    }

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)

    const ids = (await db.mailboxes.where('accountId').equals(ACCOUNT).toArray()).map((r) => r.id)
    expect(ids).toEqual(['inbox'])
  })

  it('stores what it fetched, not merely that it fetched', async () => {
    mail = {
      syncMailboxes: () =>
        Promise.resolve(page<Mailbox>({ created: [mailbox('box-1', 'Rechnungen')] })),
      syncEmailHeaders: () => Promise.resolve(page<EmailHeader>()),
      listAllEmailHeaders: async () => 'e1',
    }

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)

    const row = await db.mailboxes.get([ACCOUNT, 'box-1'])
    expect(openEnvelope(row!.payload).name).toBe('Rechnungen')
  })
})
