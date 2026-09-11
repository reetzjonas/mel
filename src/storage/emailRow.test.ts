import { describe, expect, it } from 'vitest'
import type { EmailHeader } from '../domain/email'
import { mailboxDateKey, mailboxDateRange, threadOfKey, toEmailRow } from './emailRow'

const header = (over: Partial<EmailHeader> = {}): EmailHeader =>
  ({
    id: 'e1',
    threadId: 't1',
    mailboxIds: { inbox: true },
    keywords: {},
    from: [],
    to: [],
    cc: [],
    subject: null,
    receivedAt: '2026-09-11T10:00:00Z',
    sentAt: null,
    preview: '',
    hasAttachment: false,
    size: 0,
    ...over,
  }) as EmailHeader

const inRange = (key: string, mailboxId: string) => {
  const [from, to] = mailboxDateRange(mailboxId)
  return key >= from && key <= to
}

describe('mailboxDateKey', () => {
  // The whole point: an ascending index scan has to come out newest first.
  it('sorts a later message before an earlier one', () => {
    const older = mailboxDateKey('inbox', Date.parse('2020-01-01T00:00:00Z'), 't1')
    const newer = mailboxDateKey('inbox', Date.parse('2026-01-01T00:00:00Z'), 't1')
    expect(newer < older).toBe(true)
  })

  it('pads, so a shorter timestamp cannot sort as though it were larger', () => {
    const times = [1, 1_000, 999_999_999_999, 1_757_000_000_000]
    const keys = times.map((at) => mailboxDateKey('inbox', at, 't1'))
    // Newest first is the reverse of ascending time.
    expect([...keys].sort()).toEqual([...keys].reverse())
  })

  /*
   * The separator earns its keep here: with a printable one, "inbox2" would
   * fall inside the prefix range of "inbox" and leak another folder's mail
   * into the list.
   */
  it('keeps a folder whose id extends another out of its range', () => {
    expect(inRange(mailboxDateKey('inbox', 0, 't1'), 'inbox')).toBe(true)
    expect(inRange(mailboxDateKey('inbox2', 0, 't1'), 'inbox')).toBe(false)
    expect(inRange(mailboxDateKey('inbox', 0, 't1'), 'inbox2')).toBe(false)
  })

  it('survives a header with an unparseable date instead of writing NaN', () => {
    const row = toEmailRow('a1', header({ receivedAt: 'not a date' }))
    expect(row.mailboxDates[0]).toBe(mailboxDateKey('inbox', 0, 't1'))
  })

  /*
   * The thread rides in the key so a cursor over a folder can report the
   * conversation of each message without reading the record.
   */
  it('carries the thread, and hands it back', () => {
    expect(threadOfKey(mailboxDateKey('inbox', 1, 'thread-7'))).toBe('thread-7')
    expect(threadOfKey('nonsense')).toBeNull()
  })

  it('still orders by date, whatever the threads are called', () => {
    const older = mailboxDateKey('inbox', 1, 'zzz')
    const newer = mailboxDateKey('inbox', 2, 'aaa')
    expect(newer < older).toBe(true)
  })
})

describe('toEmailRow', () => {
  it('writes one index entry per mailbox the message is in', () => {
    const row = toEmailRow('a1', header({ mailboxIds: { inbox: true, archive: true } }))
    expect(row.mailboxIds).toEqual(['inbox', 'archive'])
    expect(row.mailboxDates).toHaveLength(2)
    expect(inRange(row.mailboxDates[0]!, 'inbox')).toBe(true)
    expect(inRange(row.mailboxDates[1]!, 'archive')).toBe(true)
  })

  it('derives the flag columns from the keywords', () => {
    expect(toEmailRow('a1', header()).unread).toBe(1)
    expect(toEmailRow('a1', header({ keywords: { $seen: true } })).unread).toBe(0)
    expect(toEmailRow('a1', header({ keywords: { $flagged: true } })).flagged).toBe(1)
  })
})
