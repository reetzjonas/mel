import { beforeEach, describe, expect, it } from 'vitest'
import type { EmailHeader } from '../../domain/email'
import { db } from '../../storage/db'
import { toEmailRow } from '../../storage/emailRow'
import { readThreadMembers, readThreadWindow } from './listIndex'

const ACC = 'a1'
const INBOX = 'mb-inbox'
const SENT = 'mb-sent'

const header = (id: string, iso: string, threadId: string, mailboxId = INBOX): EmailHeader =>
  ({
    id,
    threadId,
    mailboxIds: { [mailboxId]: true },
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
  }) as EmailHeader

async function seed(rows: [id: string, iso: string, threadId: string, mailboxId?: string][]) {
  await db.emails.clear()
  for (const [id, iso, threadId, mailboxId] of rows) {
    await db.emails.put(toEmailRow(ACC, header(id, iso, threadId, mailboxId)))
  }
}

describe('readThreadWindow', () => {
  beforeEach(async () => {
    await seed([
      ['a', '2026-01-01T10:00:00Z', 't-1'],
      ['b', '2026-01-02T10:00:00Z', 't-2'],
      ['c', '2026-01-03T10:00:00Z', 't-1'],
      ['d', '2026-01-04T10:00:00Z', 't-3'],
    ])
  })

  it('lists each conversation once, newest message first', async () => {
    const { threadOrder } = await readThreadWindow(ACC, INBOX, 10)
    expect(threadOrder).toEqual(['t-3', 't-1', 't-2'])
  })

  /*
   * The point of the whole exercise: the folder is not scanned, the cursor
   * stops once the window is full. A caller asking for two conversations must
   * not be handed a third.
   */
  it('stops at the window instead of reading the folder', async () => {
    const { threadOrder, exhausted } = await readThreadWindow(ACC, INBOX, 2)
    expect(threadOrder).toEqual(['t-3', 't-1'])
    expect(exhausted).toBe(false)
  })

  it('reports the end of the folder, so paging knows to stop', async () => {
    expect((await readThreadWindow(ACC, INBOX, 10)).exhausted).toBe(true)
    expect((await readThreadWindow(ACC, 'mb-empty', 10)).threadOrder).toEqual([])
  })

  it('applies the filter while scanning, not to the finished window', async () => {
    const { threadOrder } = await readThreadWindow(ACC, INBOX, 10, (id) => id === 'b')
    expect(threadOrder).toEqual(['t-2'])
  })

  it('ignores a folder of the same id belonging to another account', async () => {
    await db.emails.put(toEmailRow('a2', header('foreign', '2026-02-01T10:00:00Z', 't-9')))
    const { threadOrder } = await readThreadWindow(ACC, INBOX, 10)
    expect(threadOrder).not.toContain('t-9')
  })
})

describe('readThreadMembers', () => {
  /*
   * Account-wide on purpose: a conversation's count and participants include
   * the replies filed in Sent, which is why this one read cannot be scoped to
   * the folder being listed.
   */
  it('collects a conversation across folders', async () => {
    await seed([
      ['a', '2026-01-01T10:00:00Z', 't-1'],
      ['reply', '2026-01-02T10:00:00Z', 't-1', SENT],
      ['other', '2026-01-03T10:00:00Z', 't-2'],
    ])
    const members = await readThreadMembers(ACC, ['t-1'])
    expect(members.get('t-1')).toEqual(['a', 'reply'])
    expect(members.has('t-2')).toBe(false)
  })

  it('asks for nothing when there is nothing on screen', async () => {
    expect((await readThreadMembers(ACC, [])).size).toBe(0)
  })
})
