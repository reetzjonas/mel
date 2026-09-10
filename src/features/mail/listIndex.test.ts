import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailHeader } from '../../domain/email'
import { db, type EmailRow } from '../../storage/db'
import { sealPlain } from '../../storage/envelope'
import { getDateOrder, getThreadIndex, resetListIndexes, splitThreads } from './listIndex'

const ACC = 'acc-1'
const MB = 'mb-inbox'

function row(
  id: string,
  threadId: string,
  accountId = ACC,
  iso = '2026-01-01T00:00:00.000Z',
): EmailRow {
  const header: EmailHeader = {
    id,
    threadId,
    mailboxIds: { [MB]: true },
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
  return {
    accountId,
    id,
    threadId,
    mailboxIds: [MB],
    receivedAt: Date.parse(header.receivedAt),
    unread: 0,
    flagged: 0,
    payload: sealPlain(header),
  }
}

const members = (index: { members: Map<string, string[]> }) =>
  Object.fromEntries([...index.members].map(([k, v]) => [k, [...v].sort()]))

describe('splitThreads', () => {
  it('cuts the range at each thread’s first id', () => {
    // Ordered by (threadId, id), the way IndexedDB returns the index range.
    const index = splitThreads(
      ['a1', 'a2', 'b1'],
      new Map([
        ['a1', 't-a'],
        ['b1', 't-b'],
      ]),
    )
    expect(members(index!)).toEqual({ 't-a': ['a1', 'a2'], 't-b': ['b1'] })
    expect(index!.threadOf.get('a2')).toBe('t-a')
  })

  it('refuses to guess when the two reads disagree', () => {
    // A thread whose first id is missing would silently swallow its messages
    // into the previous thread, so this has to report failure instead.
    expect(splitThreads(['a1', 'b1'], new Map([['b1', 't-b']]))).toBeNull()
    expect(
      splitThreads(
        ['a1'],
        new Map([
          ['a1', 't-a'],
          ['b1', 't-b'],
        ]),
      ),
    ).toBeNull()
  })
})

describe('getThreadIndex', () => {
  beforeEach(async () => {
    resetListIndexes()
    await db.emails.clear()
    await db.emails.bulkPut([
      row('a', 't-1'),
      row('b', 't-1'),
      row('c', 't-2'),
      row('x', 't-9', 'acc-2'),
    ])
  })

  it('groups every message of the account and nothing of another', async () => {
    const index = await getThreadIndex(ACC)
    expect(members(index)).toEqual({ 't-1': ['a', 'b'], 't-2': ['c'] })
    expect(index.threadOf.get('x')).toBeUndefined()
  })

  it('reads the range with getAllKeys, not the cursor fallback', async () => {
    // The fallback pairs index keys with primary keys by walking a cursor, and
    // that walk is what made this cost seconds on a large account. It only runs
    // when the cheap reads disagree, which they cannot inside one transaction —
    // so a run that needs it means the fast path silently stopped working.
    const transaction = vi.spyOn(db, 'transaction')
    await getThreadIndex(ACC)
    expect(transaction).not.toHaveBeenCalled()
    transaction.mockRestore()
  })

  it('is the same object on the next call — the scan runs once', async () => {
    expect(await getThreadIndex(ACC)).toBe(await getThreadIndex(ACC))
  })

  it('picks up an arriving message without rescanning', async () => {
    const index = await getThreadIndex(ACC)
    await db.emails.put(row('d', 't-2'))
    expect(members(index)).toEqual({ 't-1': ['a', 'b'], 't-2': ['c', 'd'] })
  })

  it('drops a deleted message and the thread it emptied', async () => {
    const index = await getThreadIndex(ACC)
    await db.emails.delete([ACC, 'c'])
    expect(index.members.has('t-2')).toBe(false)
    expect(index.threadOf.has('c')).toBe(false)
  })

  it('moves a message that changed thread', async () => {
    const index = await getThreadIndex(ACC)
    await db.emails.put(row('b', 't-2'))
    expect(members(index)).toEqual({ 't-1': ['a'], 't-2': ['b', 'c'] })
  })

  it('keeps rows written while the scan was still running', async () => {
    resetListIndexes()
    const pending = getThreadIndex(ACC)
    await db.emails.put(row('late', 't-1'))
    expect(members(await pending)['t-1']).toEqual(['a', 'b', 'late'])
  })
})

/** Counts the scans of the date index — the read this cache exists to avoid. */
function countDateScans() {
  const original = db.emails.where.bind(db.emails)
  const counter = { n: 0 }
  vi.spyOn(db.emails, 'where').mockImplementation(((...args: unknown[]) => {
    if (args[0] === '[accountId+receivedAt]') counter.n++
    return (original as (...a: unknown[]) => unknown)(...args)
  }) as never)
  return counter
}

describe('getDateOrder', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    resetListIndexes()
    await db.emails.clear()
    // Inserted oldest-first so primary-key order is not date order.
    await db.emails.bulkPut([
      row('a', 't-1', ACC, '2020-01-01T00:00:00.000Z'),
      row('b', 't-1', ACC, '2023-01-01T00:00:00.000Z'),
      row('c', 't-2', ACC, '2026-01-01T00:00:00.000Z'),
      row('x', 't-9', 'acc-2', '2025-01-01T00:00:00.000Z'),
    ])
  })

  it('lists the account newest first, and only this account', async () => {
    expect(await getDateOrder(ACC)).toEqual(['c', 'b', 'a'])
  })

  it('scans once and reuses it across folders', async () => {
    const scans = countDateScans()
    await getDateOrder(ACC)
    await getDateOrder(ACC)
    expect(scans.n).toBe(1)
  })

  it('survives a read or flag change — those do not move a row', async () => {
    // The refresh after marking a message read is the frequent case; rescanning
    // the account for it is exactly what made every list update expensive.
    await getDateOrder(ACC)
    const scans = countDateScans()
    await db.emails.put({ ...row('a', 't-1', ACC, '2020-01-01T00:00:00.000Z'), unread: 0 })
    expect(await getDateOrder(ACC)).toEqual(['c', 'b', 'a'])
    expect(scans.n).toBe(0)
  })

  it('is dropped by an arriving message and rebuilt in date position', async () => {
    await getDateOrder(ACC)
    await db.emails.put(row('mid', 't-3', ACC, '2024-06-01T00:00:00.000Z'))
    expect(await getDateOrder(ACC)).toEqual(['c', 'mid', 'b', 'a'])
  })

  it('is dropped by a deleted message', async () => {
    await getDateOrder(ACC)
    await db.emails.delete([ACC, 'c'])
    expect(await getDateOrder(ACC)).toEqual(['b', 'a'])
  })

  it('does not cache a scan a write raced', async () => {
    const pending = getDateOrder(ACC)
    await db.emails.put(row('late', 't-4', ACC, '2027-01-01T00:00:00.000Z'))
    await pending
    // Whether the racing row made it into that result is up to IndexedDB; the
    // next read must not be answered from it either way.
    expect(await getDateOrder(ACC)).toEqual(['late', 'c', 'b', 'a'])
  })
})
