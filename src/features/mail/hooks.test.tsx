import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailHeader } from '../../domain/email'
import { db, type EmailRow } from '../../storage/db'
import { sealPlain } from '../../storage/envelope'
import { useMailboxEmails } from './hooks'

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
    accountId,
    id,
    threadId: `t-${id}`,
    mailboxIds,
    receivedAt: Date.parse(iso),
    unread: 1,
    flagged: 0,
    payload: sealPlain(header(id, iso, mailboxIds)),
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
        row(`m${String(i).padStart(3, '0')}`, new Date(Date.UTC(2024, 0, 1) + i * 60_000).toISOString()),
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
