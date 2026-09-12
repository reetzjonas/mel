import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailHeader } from '../../domain/email'
import { db, type EmailRow } from '../../storage/db'
import { toEmailRow } from '../../storage/emailRow'
import { sealPlain } from '../../storage/envelope'
import { setFullSyncProgress } from '../../sync/progress'
import {
  hiddenMailboxIds,
  useAccounts,
  useCanSend,
  useEmail,
  useFullSyncProgress,
  useMailboxEmails,
  useMailboxes,
  useThread,
} from './hooks'

const ACC = 'acc-1'
const OTHER_ACC = 'acc-2'
const MB = 'mb-inbox'
const OTHER_MB = 'mb-archive'

function header(id: string, iso: string, mailboxIds: string[]): EmailHeader {
  const map: Record<string, true> = {}
  for (const m of mailboxIds) map[m] = true
  return {
    id,
    threadId: `t-${id}`,
    mailboxIds: map,
    keywords: {},
    from: [],
    to: [],
    cc: [],
    subject: id,
    receivedAt: iso,
    sentAt: null,
    preview: '',
    hasAttachment: false,
    size: 0,
  }
}

function row(id: string, iso: string, mailboxIds = [MB], accountId = ACC): EmailRow {
  return {
    ...toEmailRow(accountId, header(id, iso, mailboxIds)),
    unread: 1,
    flagged: 0,
  }
}

const ids = (list: { emails: EmailHeader[] | undefined }) => (list.emails ?? []).map((h) => h.id)

/** Counts the expensive whole-mailbox read, which is what this hook must avoid. */
function countFullReads() {
  const original = db.emails.where.bind(db.emails)
  const counter = { n: 0 }
  vi.spyOn(db.emails, 'where').mockImplementation(((...args: unknown[]) => {
    if (args[0] === 'mailboxIds') counter.n++
    return (original as (...a: unknown[]) => unknown)(...args)
  }) as never)
  return counter
}

async function mounted() {
  const view = renderHook(() => useMailboxEmails(ACC, MB))
  await waitFor(() => expect(view.result.current.emails).toBeDefined())
  return view
}

describe('useMailboxEmails', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    await db.emails.clear()
    // Inserted oldest-first so primary-key order is not date order.
    await db.emails.bulkPut([
      row('a', '2020-01-01T00:00:00.000Z'),
      row('b', '2023-01-01T00:00:00.000Z'),
      row('c', '2026-01-01T00:00:00.000Z'),
    ])
  })

  it('lists the mailbox newest first', async () => {
    const { result } = await mounted()
    expect(ids(result.current)).toEqual(['c', 'b', 'a'])
  })

  it('does not re-read the whole mailbox when a single row changes', async () => {
    // The regression this hook exists for: markRead() on one message used to
    // invalidate the whole list, re-reading and re-decrypting every row.
    const reads = countFullReads()
    const { result } = await mounted()
    const afterLoad = reads.n

    await act(async () => {
      await db.emails.put({ ...row('a', '2020-01-01T00:00:00.000Z'), unread: 0 })
    })

    await waitFor(() => expect(ids(result.current)).toEqual(['c', 'b', 'a']))
    expect(reads.n).toBe(afterLoad)
  })

  it('reflects a changed payload, not just the row', async () => {
    const { result } = await mounted()
    const seen = header('a', '2020-01-01T00:00:00.000Z', [MB])
    seen.keywords['$seen'] = true

    await act(async () => {
      await db.emails.put({ ...row('a', '2020-01-01T00:00:00.000Z'), payload: sealPlain(seen) })
    })

    // Dexie reports a dotted-path diff here; a naive shallow merge would drop it.
    await waitFor(() =>
      expect(result.current.emails?.find((h) => h.id === 'a')?.keywords['$seen']).toBe(true),
    )
  })

  it('inserts an arriving message at its date position', async () => {
    const { result } = await mounted()

    await act(async () => {
      await db.emails.put(row('mid', '2024-06-01T00:00:00.000Z'))
    })

    await waitFor(() => expect(ids(result.current)).toEqual(['c', 'mid', 'b', 'a']))
  })

  it('drops a message that moved to another mailbox', async () => {
    const { result } = await mounted()

    await act(async () => {
      await db.emails.put(row('b', '2023-01-01T00:00:00.000Z', [OTHER_MB]))
    })

    await waitFor(() => expect(ids(result.current)).toEqual(['c', 'a']))
  })

  it('drops a deleted message', async () => {
    const { result } = await mounted()

    await act(async () => {
      await db.emails.delete([ACC, 'c'])
    })

    await waitFor(() => expect(ids(result.current)).toEqual(['b', 'a']))
  })

  it('ignores writes for another account or another mailbox', async () => {
    const { result } = await mounted()

    await act(async () => {
      await db.emails.put(row('foreign', '2027-01-01T00:00:00.000Z', [MB], OTHER_ACC))
      await db.emails.put(row('elsewhere', '2027-01-01T00:00:00.000Z', [OTHER_MB]))
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(ids(result.current)).toEqual(['c', 'b', 'a'])
  })

  it('stops listening once unmounted', async () => {
    const { result, unmount } = await mounted()
    const before = ids(result.current)
    unmount()

    await act(async () => {
      await db.emails.put(row('after-unmount', '2027-01-01T00:00:00.000Z'))
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(ids(result.current)).toEqual(before)
  })
})

describe('useMailboxEmails paging', () => {
  const MANY = 250

  beforeEach(async () => {
    vi.restoreAllMocks()
    await db.emails.clear()
    await db.emails.bulkPut(
      Array.from({ length: MANY }, (_, i) =>
        row(
          `m${String(i).padStart(3, '0')}`,
          new Date(Date.UTC(2024, 0, 1) + i * 60_000).toISOString(),
        ),
      ),
    )
  })

  it('materialises only the first page but reports the real total', async () => {
    const { result } = await mounted()
    expect(result.current.emails).toHaveLength(100)
    expect(result.current.total).toBe(MANY)
    // Newest first, so the highest index leads.
    expect(result.current.emails?.[0]?.id).toBe('m249')
  })

  it('reads no more payloads than the page it shows', async () => {
    const spy = vi.spyOn(db.emails, 'bulkGet')
    await mounted()
    const fetched = spy.mock.calls.flatMap((c) => c[0] as unknown[]).length
    expect(fetched).toBe(100)
  })

  it('extends the window on demand and stops at the end', async () => {
    const { result } = await mounted()

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.emails).toHaveLength(200))

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.emails).toHaveLength(MANY))

    // Already complete: further calls must not grow it past the mailbox.
    await act(async () => {
      result.current.loadMore()
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.emails).toHaveLength(MANY)
  })

  it('keeps a newly arrived message at the top of the first page', async () => {
    const { result } = await mounted()

    await act(async () => {
      await db.emails.put(row('newest', '2030-01-01T00:00:00.000Z'))
    })

    await waitFor(() => expect(result.current.emails?.[0]?.id).toBe('newest'))
    expect(result.current.total).toBe(MANY + 1)
  })
})

describe('useMailboxEmails grouped paging', () => {
  const THREADS = 250

  beforeEach(async () => {
    vi.restoreAllMocks()
    await db.emails.clear()
    await db.mailboxes.clear()
    await db.emails.bulkPut(
      Array.from({ length: THREADS }, (_, i) => {
        const h = header(
          `g${String(i).padStart(3, '0')}`,
          new Date(Date.UTC(2024, 0, 1) + i * 60_000).toISOString(),
          [MB],
        )
        h.threadId = `gt-${String(i).padStart(3, '0')}`
        return { ...toEmailRow(ACC, h), unread: 1, flagged: 0 }
      }),
    )
  })

  const view = async () => {
    const v = renderHook(() => useMailboxEmails(ACC, MB, undefined, true))
    await waitFor(() => expect(v.result.current.conversations).toBeDefined())
    return v
  }

  /*
   * Grouped paging goes back to the index rather than slicing something
   * already in memory — reading the rest of the folder is exactly what the
   * windowed read avoids. So "there is more" cannot be inferred from the
   * length of what is loaded, and this is where that would show.
   */
  it('extends the window on demand and stops at the end', async () => {
    const { result } = await view()
    expect(result.current.conversations).toHaveLength(100)

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.conversations).toHaveLength(200))

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.conversations).toHaveLength(THREADS))

    // Already complete: a further call must not loop or grow past the folder.
    await act(async () => {
      result.current.loadMore()
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.conversations).toHaveLength(THREADS)
  })

  it('keeps the newest conversation first across a page', async () => {
    const { result } = await view()
    expect(result.current.conversations?.[0]?.threadId).toBe('gt-249')
    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.conversations).toHaveLength(200))
    expect(result.current.conversations?.[0]?.threadId).toBe('gt-249')
    expect(result.current.conversations?.[199]?.threadId).toBe('gt-050')
  })
})

describe('useMailboxEmails consistency', () => {
  it('drops a row whose own header says it left the mailbox', async () => {
    // Guards the case where the ordering index still reports membership after
    // a move: the row would come back from the cache refill with an updated
    // header, so everything about it changed except that it was still listed.
    await db.emails.clear()
    await db.emails.bulkPut([
      row('stays', '2024-01-01T00:00:00.000Z'),
      row('moved', '2024-01-02T00:00:00.000Z'),
    ])
    const { result } = await mounted()
    expect(ids(result.current)).toEqual(['moved', 'stays'])

    // Payload says inbox, index column deliberately left claiming junk.
    const stale = await db.emails.get([ACC, 'moved'])
    await act(async () => {
      await db.emails.put({
        ...stale!,
        mailboxIds: [MB],
        payload: sealPlain(header('moved', '2024-01-02T00:00:00.000Z', ['other-box'])),
      })
    })

    await waitFor(() => expect(ids(result.current)).toEqual(['stays']))
  })
})

describe('useMailboxEmails grouped', () => {
  const THREAD = 't-shared'

  /** Like row(), but with an explicit thread and sender. */
  function threadRow(
    id: string,
    iso: string,
    mailboxIds = [MB],
    threadId = THREAD,
    sender = 'anna@example.com',
  ): EmailRow {
    const h = header(id, iso, mailboxIds)
    h.threadId = threadId
    h.from = [{ name: null, email: sender }]
    return { ...toEmailRow(ACC, h), unread: 1, flagged: 0 }
  }

  async function groupedView() {
    const view = renderHook(() => useMailboxEmails(ACC, MB, undefined, true))
    await waitFor(() => expect(view.result.current.conversations).toBeDefined())
    return view
  }

  beforeEach(async () => {
    vi.restoreAllMocks()
    await db.emails.clear()
    await db.mailboxes.clear()
    await db.emails.bulkPut([
      threadRow('in-1', '2026-01-01T10:00:00.000Z'),
      // The reply we sent: another folder, same thread.
      threadRow('out-1', '2026-01-01T11:00:00.000Z', [OTHER_MB], THREAD, 'me@example.com'),
      threadRow('in-2', '2026-01-01T12:00:00.000Z'),
      threadRow('lone', '2026-01-02T10:00:00.000Z', [MB], 't-lone'),
    ])
  })

  it('collapses a thread into one row, newest thread first', async () => {
    const { result } = await groupedView()
    const rows = result.current.conversations ?? []

    expect(rows.map((c) => c.threadId)).toEqual(['t-lone', THREAD])
    expect(result.current.total).toBe(2)
    expect(rows[1]?.latest.id).toBe('in-2')
  })

  it('counts the messages in other folders but acts only on this one', async () => {
    const { result } = await groupedView()
    const conversation = result.current.conversations?.find((c) => c.threadId === THREAD)

    // The pairing of the two index scans behind this (index keys and primary
    // keys of the same range) is the load-bearing assumption: get it wrong and
    // messages end up attributed to the wrong thread.
    expect(conversation?.messages.map((m) => m.id)).toEqual(['in-1', 'out-1', 'in-2'])
    expect(conversation?.ids).toEqual(['in-1', 'in-2'])
    expect(conversation?.participants.map((p) => p.email)).toEqual([
      'anna@example.com',
      'me@example.com',
    ])
  })

  it('picks up a reply arriving in another folder', async () => {
    const { result } = await groupedView()

    await act(async () => {
      await db.emails.put(
        threadRow('out-2', '2026-01-01T13:00:00.000Z', [OTHER_MB], THREAD, 'me@example.com'),
      )
    })

    await waitFor(() =>
      expect(
        result.current.conversations?.find((c) => c.threadId === THREAD)?.messages,
      ).toHaveLength(4),
    )
    // Still standing on the newest message that is actually in this mailbox.
    expect(result.current.conversations?.find((c) => c.threadId === THREAD)?.latest.id).toBe('in-2')
  })

  it('drops the row once its last message leaves the mailbox', async () => {
    const { result } = await groupedView()

    await act(async () => {
      await db.emails.bulkPut([
        threadRow('in-1', '2026-01-01T10:00:00.000Z', [OTHER_MB]),
        threadRow('in-2', '2026-01-01T12:00:00.000Z', [OTHER_MB]),
      ])
    })

    await waitFor(() =>
      expect(result.current.conversations?.map((c) => c.threadId)).toEqual(['t-lone']),
    )
  })

  /** A role mailbox, which is what the exclusion rules key off. */
  async function putMailbox(id: string, role: 'trash' | 'drafts') {
    await db.mailboxes.put({
      accountId: ACC,
      id,
      parentId: null,
      role,
      sortOrder: 0,
      payload: sealPlain({
        id,
        name: role,
        parentId: null,
        role,
        sortOrder: 0,
        totalEmails: 0,
        unreadEmails: 0,
        totalThreads: 0,
        unreadThreads: 0,
        mayRename: true,
        mayDelete: true,
        mayCreateChild: true,
        mayAddItems: true,
        mayRemoveItems: true,
        mayReadItems: true,
      }),
    })
  }

  it('leaves out messages that only live in trash', async () => {
    await putMailbox('mb-trash', 'trash')
    await db.emails.put(threadRow('binned', '2026-01-01T13:00:00.000Z', ['mb-trash']))

    const { result } = await groupedView()
    const conversation = result.current.conversations?.find((c) => c.threadId === THREAD)
    expect(conversation?.messages.map((m) => m.id)).toEqual(['in-1', 'out-1', 'in-2'])
  })

  it('leaves out an unsent draft, and lists it again in the drafts folder', async () => {
    await putMailbox('mb-drafts', 'drafts')
    await db.emails.put(threadRow('unsent', '2026-01-01T13:00:00.000Z', ['mb-drafts']))

    const { result } = await groupedView()
    // Nothing in a draft has been seen by the other side, so it is not part of
    // the exchange the inbox row describes.
    expect(
      result.current.conversations?.find((c) => c.threadId === THREAD)?.messages.map((m) => m.id),
    ).toEqual(['in-1', 'out-1', 'in-2'])

    const drafts = renderHook(() => useMailboxEmails(ACC, 'mb-drafts', undefined, true))
    await waitFor(() => expect(drafts.result.current.conversations).toBeDefined())
    expect(drafts.result.current.conversations?.[0]?.ids).toEqual(['unsent'])
  })

  it('hands the reading pane the same messages the row counted', async () => {
    await putMailbox('mb-drafts', 'drafts')
    await db.emails.put(threadRow('unsent', '2026-01-01T13:00:00.000Z', ['mb-drafts']))

    const view = renderHook(() => useThread(ACC, THREAD, MB))
    // Otherwise the pane says "3 messages" over a stack of four.
    await waitFor(() =>
      expect(view.result.current?.map((m) => m.id)).toEqual(['in-1', 'out-1', 'in-2']),
    )
  })
})

async function putMailbox(id: string, role: string | null, over: Record<string, unknown> = {}) {
  await db.mailboxes.put({
    accountId: ACC,
    id,
    role: role as never,
    parentId: null,
    sortOrder: (over['sortOrder'] as number) ?? 0,
    payload: sealPlain({
      id,
      name: id,
      role,
      parentId: null,
      sortOrder: 0,
      ...over,
    } as never),
  })
}

describe('the accounts on this device', () => {
  beforeEach(() => db.accounts.clear())

  it('skips one whose payload is still sealed rather than failing the list', async () => {
    /*
     * A locked account cannot be opened until the passphrase is entered, and
     * the UnlockGate is what asks for it. Throwing here would take the whole
     * app down behind the gate that is meant to recover it.
     */
    await db.accounts.put({
      id: 'open',
      provider: 'jmap',
      encrypted: false,
      payload: sealPlain({ account: { id: 'open', label: 'alice' } } as never),
    })
    await db.accounts.put({
      id: 'locked',
      provider: 'jmap',
      encrypted: true,
      payload: { enc: { iv: 'x', data: 'y' } } as never,
    })

    const { result } = renderHook(() => useAccounts())

    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current![0]!.id).toBe('open')
  })
})

describe('whether a message may be written at all', () => {
  beforeEach(() => db.accounts.clear())

  const withSubmission = (submission: boolean) =>
    db.accounts.put({
      id: 'a1',
      provider: 'jmap',
      encrypted: false,
      payload: sealPlain({
        account: { id: 'a1', capabilities: { submission } },
      } as never),
    })

  it('is false until the answer is in, not optimistic', async () => {
    /*
     * A Compose button that appears a moment late is far better than one that
     * appears, gets pressed, and drops the message into the outbox for a
     * server that was never going to send it.
     */
    await withSubmission(true)

    const { result } = renderHook(() => useCanSend())

    expect(result.current).toBe(false)
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('stays false for a server that only stores mail', async () => {
    await withSubmission(false)

    const { result } = renderHook(() => useCanSend())

    await waitFor(() => expect(result.current).toBe(false))
  })
})

describe('the folder list', () => {
  beforeEach(() => db.mailboxes.clear())

  it('puts the folders that matter first and sorts the rest sensibly', async () => {
    /*
     * Inbox, Drafts, Sent, Archive, Junk, Trash in that order, whatever the
     * server's own sortOrder says — then the server's order, then the name.
     */
    await putMailbox('Trash', 'trash')
    await putMailbox('Inbox', 'inbox')
    await putMailbox('Zebra', null, { name: 'Zebra', sortOrder: 1 })
    await putMailbox('Alpha', null, { name: 'Alpha', sortOrder: 1 })
    await putMailbox('First', null, { name: 'First', sortOrder: 0 })

    const { result } = renderHook(() => useMailboxes(ACC))

    await waitFor(() => expect(result.current).toHaveLength(5))
    expect(result.current!.map((m) => m.name)).toEqual([
      'Inbox',
      'Trash',
      'First',
      'Alpha',
      'Zebra',
    ])
  })

  it('is empty, not undefined, without an account', async () => {
    const { result } = renderHook(() => useMailboxes(undefined))
    await waitFor(() => expect(result.current).toEqual([]))
  })
})

describe('the folders a conversation does not count', () => {
  beforeEach(() => db.mailboxes.clear())

  it('leaves out trash, junk and drafts', async () => {
    /*
     * A message you deleted should not go on padding the row you deleted it
     * from, and an unsent draft is not part of the exchange yet — the other
     * side has seen none of it.
     */
    await putMailbox('mb-trash', 'trash')
    await putMailbox('mb-junk', 'junk')
    await putMailbox('mb-drafts', 'drafts')
    await putMailbox('mb-inbox', 'inbox')

    const hidden = await hiddenMailboxIds(ACC, 'mb-inbox')

    expect([...hidden].sort()).toEqual(['mb-drafts', 'mb-junk', 'mb-trash'])
  })

  it('never hides the folder being looked at', async () => {
    // In Trash, the deleted messages are the thing you came to see.
    await putMailbox('mb-trash', 'trash')
    await putMailbox('mb-junk', 'junk')

    const hidden = await hiddenMailboxIds(ACC, 'mb-trash')

    expect([...hidden]).toEqual(['mb-junk'])
  })
})

describe('progress of the first full fetch', () => {
  it('follows the store and reports nothing without an account', async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useFullSyncProgress(id),
      { initialProps: { id: ACC as string | undefined } },
    )

    expect(result.current).toBeNull()

    act(() => setFullSyncProgress(ACC, { done: 40, total: 36_000 }))
    expect(result.current).toEqual({ done: 40, total: 36_000 })

    rerender({ id: undefined })
    expect(result.current).toBeNull()

    act(() => setFullSyncProgress(ACC, null))
  })
})

describe('a single message', () => {
  beforeEach(() => db.emails.clear())

  it('is null when there is none, and undefined only while looking', async () => {
    /*
     * The reading pane tells these apart: undefined is "still loading", null
     * is "this message is gone" — which is what it shows after a delete on
     * another device.
     */
    const { result } = renderHook(() => useEmail(ACC, 'nope'))

    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current).toBeNull())
  })

  it('opens the stored payload when it is there', async () => {
    await db.emails.put(row('m1', '2026-09-10T10:00:00Z'))

    const { result } = renderHook(() => useEmail(ACC, 'm1'))

    await waitFor(() => expect(result.current?.id).toBe('m1'))
  })
})
