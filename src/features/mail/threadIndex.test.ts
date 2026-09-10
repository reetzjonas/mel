import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailHeader } from '../../domain/email'
import { db, type EmailRow } from '../../storage/db'
import { sealPlain } from '../../storage/envelope'
import { getThreadIndex, resetThreadIndex, splitThreads } from './threadIndex'

const ACC = 'acc-1'
const MB = 'mb-inbox'

function row(id: string, threadId: string, accountId = ACC): EmailRow {
  const header: EmailHeader = {
    id,
    threadId,
    mailboxIds: { [MB]: true },
    keywords: {},
    from: [],
    to: [],
    cc: [],
    subject: id,
    receivedAt: '2026-01-01T00:00:00.000Z',
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
    resetThreadIndex()
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
    resetThreadIndex()
    const pending = getThreadIndex(ACC)
    await db.emails.put(row('late', 't-1'))
    expect(members(await pending)['t-1']).toEqual(['a', 'b', 'late'])
  })
})
