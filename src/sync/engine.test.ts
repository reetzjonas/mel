import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailHeader } from '../domain/email'
import type { Mailbox } from '../domain/mailbox'
import {
  CannotCalculateChanges,
  type CalendarProvider,
  type ContactsProvider,
  type MailProvider,
  type SyncPage,
} from '../providers/types'
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

/** The providers the engine talks to; each test supplies the parts it needs. */
let mail: Partial<MailProvider> | null
let contacts: Partial<ContactsProvider> | null
let calendars: Partial<CalendarProvider> | null

vi.mock('./connections', () => ({
  connectionFor: () => Promise.resolve({ mail, contacts, calendars }),
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
    contacts = null
    calendars = null
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

  it('announces the first full fetch before it asks, and clears it however it ends', async () => {
    /*
     * The first request is the longest wait of the lot on a large mailbox, and
     * it is exactly the stretch where the list would otherwise still say "No
     * messages" — a wrong answer, not a slow one. Reporting only after the
     * first page arrives leaves that window uncovered.
     */
    const { getFullSyncProgress } = await import('./progress')
    const seenBeforeFirstPage: unknown[] = []
    mail = {
      syncMailboxes: () => Promise.resolve(page<Mailbox>()),
      listAllEmailHeaders: async (onPage) => {
        seenBeforeFirstPage.push(getFullSyncProgress(ACCOUNT))
        await onPage({ headers: [header('a')], state: 'e1', total: 10 })
        return 'e1'
      },
    }

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)

    expect(seenBeforeFirstPage).toEqual([{ done: 0, total: null }])
    // And nothing is left standing afterwards, or the bar claims a fetch is
    // still running.
    expect(getFullSyncProgress(ACCOUNT)).toBeNull()

    mail = {
      syncMailboxes: () => Promise.resolve(page<Mailbox>()),
      listAllEmailHeaders: () => Promise.reject(new Error('connection lost')),
    }
    await db.syncState.where('accountId').equals(ACCOUNT).delete()
    await expect(syncAccount(ACCOUNT)).rejects.toThrow('connection lost')
    expect(getFullSyncProgress(ACCOUNT)).toBeNull()
  })

  it('refetches the folder list too when the server forgot its state', async () => {
    // Same failure as for email, and the same answer — but the mailbox path
    // has its own copy of it, so it needs its own proof.
    await db.syncState.put({
      accountId: ACCOUNT,
      collection: 'Mailbox',
      state: 'stale',
      updatedAt: 0,
    })
    await db.mailboxes.put({
      accountId: ACCOUNT,
      id: 'ancient',
      parentId: null,
      role: null,
      sortOrder: 0,
      payload: { plain: mailbox('ancient') },
    } as never)
    let asked = 0
    mail = {
      syncMailboxes: (since) => {
        asked += 1
        return since
          ? Promise.reject(new CannotCalculateChanges())
          : Promise.resolve(page<Mailbox>({ created: [mailbox('fresh')], newState: 'm9' }))
      },
      syncEmailHeaders: () => Promise.resolve(page<EmailHeader>()),
      listAllEmailHeaders: async () => 'e1',
    }

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)

    expect(asked).toBe(2)
    const ids = (await db.mailboxes.where('accountId').equals(ACCOUNT).toArray()).map((r) => r.id)
    expect(ids).toEqual(['fresh'])
  })
})

/** A contact with only the fields the engine reads. */
const contact = (id: string, fullName: string, addressBookIds = { ab: true as const }) =>
  ({
    id,
    fullName,
    given: '',
    surname: '',
    organization: '',
    emails: [],
    addressBookIds,
  }) as never

describe('syncing contacts and calendars', () => {
  beforeEach(async () => {
    mail = null
    contacts = null
    calendars = null
    for (const table of [db.addressBooks, db.contacts, db.calendars, db.events, db.syncState]) {
      await table.where('accountId').equals(ACCOUNT).delete()
    }
  })

  it('gives each collection its own cursor', async () => {
    /*
     * Address books and cards are separate JMAP collections with separate
     * states. Storing them under one key would feed a card state back as a
     * book state, and the server would reject or, worse, answer it.
     */
    contacts = {
      syncAddressBooks: () =>
        Promise.resolve(
          page({ created: [{ id: 'ab', name: 'Personal' } as never], newState: 'ab-1' }),
        ),
      syncContacts: () =>
        Promise.resolve(page({ created: [contact('c1', 'Ada')], newState: 'card-1' })),
    }

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)

    expect(await storedState('AddressBook')).toBe('ab-1')
    expect(await storedState('ContactCard')).toBe('card-1')
  })

  it('derives the sort key the list orders by, rather than storing only the card', async () => {
    // The contacts list reads this index column; a card whose key never got
    // written sorts to the front of the list under an empty letter heading.
    contacts = {
      syncAddressBooks: () => Promise.resolve(page()),
      syncContacts: () =>
        Promise.resolve(page({ created: [contact('c1', 'Ada Lovelace')], newState: 's' })),
    }

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)

    expect((await db.contacts.get([ACCOUNT, 'c1']))!.sortKey).toBe('ada lovelace')
  })

  it('prunes cards the server no longer has on a full fetch', async () => {
    // A delta only names what changed, so a card deleted on another device
    // while this one was away is never mentioned again.
    await db.contacts.put({
      accountId: ACCOUNT,
      id: 'deleted-elsewhere',
      addressBookIds: ['ab'],
      sortKey: 'x',
      payload: { plain: contact('deleted-elsewhere', 'X') },
    } as never)
    contacts = {
      syncAddressBooks: () => Promise.resolve(page()),
      syncContacts: () => Promise.resolve(page({ created: [contact('c1', 'Ada')], newState: 's' })),
    }

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)

    const ids = (await db.contacts.where('accountId').equals(ACCOUNT).toArray()).map((r) => r.id)
    expect(ids).toEqual(['c1'])
  })

  it('wipes and refetches when the server has forgotten the contact state', async () => {
    /*
     * Keeping the local rows and refetching over them would leave anything
     * deleted in the meantime behind for ever: the full page that follows
     * cannot name what it does not know about.
     */
    await db.syncState.put({
      accountId: ACCOUNT,
      collection: 'ContactCard',
      state: 'stale',
      updatedAt: 0,
    })
    await db.contacts.put({
      accountId: ACCOUNT,
      id: 'ancient',
      addressBookIds: ['ab'],
      sortKey: 'x',
      payload: { plain: contact('ancient', 'X') },
    } as never)
    contacts = {
      syncAddressBooks: () => Promise.resolve(page()),
      syncContacts: (since) =>
        since
          ? Promise.reject(new CannotCalculateChanges())
          : Promise.resolve(page({ created: [contact('c1', 'Ada')], newState: 'fresh' })),
    }

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)

    const ids = (await db.contacts.where('accountId').equals(ACCOUNT).toArray()).map((r) => r.id)
    expect(ids).toEqual(['c1'])
    expect(await storedState('ContactCard')).toBe('fresh')
  })

  it('keeps asking a collection while the server says there is more', async () => {
    const pages = [
      page({ created: [contact('a', 'A')], newState: 's1', hasMore: true }),
      page({ created: [contact('b', 'B')], newState: 's2', hasMore: false }),
    ]
    contacts = {
      syncAddressBooks: () => Promise.resolve(page()),
      syncContacts: () => Promise.resolve(pages.shift()!),
    }

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)

    const ids = (await db.contacts.where('accountId').equals(ACCOUNT).toArray()).map((r) => r.id)
    expect(ids.sort()).toEqual(['a', 'b'])
  })

  it('keeps an event’s calendars as an index column, not only inside the payload', async () => {
    // The month view queries by calendar to honour the visibility toggles; it
    // never opens a payload to decide what to draw.
    calendars = {
      syncCalendars: () => Promise.resolve(page({ created: [{ id: 'cal' }], newState: 'c1' })),
      syncEvents: () =>
        Promise.resolve(
          page({ created: [{ id: 'e1', calendarIds: { cal: true } }], newState: 'e1' }),
        ),
    } as never

    const { syncAccount } = await import('./engine')
    await syncAccount(ACCOUNT)

    expect((await db.events.get([ACCOUNT, 'e1']))!.calendarIds).toEqual(['cal'])
  })

  it('skips a collection the server does not offer', async () => {
    // A server without contacts must not fail the whole sync — mail still has
    // to arrive.
    const { syncAccount } = await import('./engine')

    await expect(syncAccount(ACCOUNT)).resolves.toBeUndefined()
    expect(await db.syncState.where('accountId').equals(ACCOUNT).count()).toBe(0)
  })
})

describe('one sync at a time', () => {
  beforeEach(async () => {
    mail = null
    contacts = null
    calendars = null
    await db.syncState.where('accountId').equals(ACCOUNT).delete()
  })

  it('joins a second caller onto the pass already running', async () => {
    /*
     * Push, the poll timer and a manual refresh can all fire at once. Two
     * passes over the same account would duplicate every request and race each
     * other's writes, which is what the request storm on first login was.
     */
    let started = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    contacts = {
      syncAddressBooks: async () => {
        started += 1
        await gate
        return page()
      },
      syncContacts: () => Promise.resolve(page()),
    }

    const { syncAccount, syncSettled } = await import('./engine')
    const first = syncAccount(ACCOUNT)
    const second = syncAccount(ACCOUNT)

    expect(second).toBe(first)
    release()
    await Promise.all([first, second])
    expect(started).toBe(1)

    // And once it is over, there is nothing left to wait for.
    await expect(syncSettled(ACCOUNT)).resolves.toBeUndefined()
  })

  it('lets a caller wait out a pass that fails, rather than adopting its error', async () => {
    /*
     * Sign-out awaits this before wiping the tables. If a failing sync threw
     * here, the wipe would be skipped and the previous user's mail would stay
     * on the device.
     */
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    contacts = {
      syncAddressBooks: async () => {
        await gate
        throw new Error('connection lost')
      },
      syncContacts: () => Promise.resolve(page()),
    }

    const { syncAccount, syncSettled } = await import('./engine')
    const running = syncAccount(ACCOUNT)
    running.catch(() => {})
    const settled = syncSettled(ACCOUNT)
    release()

    await expect(settled).resolves.toBeUndefined()
    await expect(running).rejects.toThrow('connection lost')
  })
})
