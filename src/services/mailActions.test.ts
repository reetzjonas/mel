import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailHeader } from '../domain/email'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { mailboxDateRange } from '../storage/emailRow'
import { bulkDelete, bulkMove, bulkSetKeyword } from './mailActions'

const enqueued: Array<Record<string, unknown>> = []
vi.mock('../sync/outbox', () => ({
  enqueue: (_accountId: string, action: Record<string, unknown>) => {
    enqueued.push(action)
    return Promise.resolve(1)
  },
}))

const ACC = 'acc'
const INBOX = 'mb-inbox'
const TRASH = 'mb-trash'

const header = (id: string, mailboxId: string): EmailHeader =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: { [mailboxId]: true },
    keywords: {},
    from: [],
    to: [],
    cc: [],
    subject: id,
    preview: '',
    receivedAt: 0,
    hasAttachment: false,
    size: 0,
  }) as unknown as EmailHeader

async function seed(ids: Array<[string, string]>) {
  await db.emails.clear()
  await db.mailboxes.clear()
  for (const [id, role] of [
    [INBOX, 'inbox'],
    [TRASH, 'trash'],
  ] as const) {
    await db.mailboxes.put({
      accountId: ACC,
      id,
      role,
      parentId: null,
      sortOrder: 0,
      payload: sealPlain({ id, name: role, role, parentId: null } as never),
    })
  }
  for (const [id, mailboxId] of ids) {
    await db.emails.put({
      accountId: ACC,
      id,
      threadId: `t-${id}`,
      receivedAt: 0,
      mailboxIds: [mailboxId],
      mailboxDates: [],
      unread: 1,
      flagged: 0,
      payload: sealPlain(header(id, mailboxId)),
    })
  }
}

describe('bulk actions', () => {
  beforeEach(() => {
    enqueued.length = 0
  })

  it('queues one outbox action for the whole selection, not one per message', async () => {
    await seed([
      ['a', INBOX],
      ['b', INBOX],
      ['c', INBOX],
    ])
    await bulkSetKeyword(ACC, ['a', 'b', 'c'], '$seen', true)

    expect(enqueued).toHaveLength(1)
    expect(Object.keys(enqueued[0]!['updates'] as object)).toEqual(['a', 'b', 'c'])
    expect((await db.emails.get([ACC, 'a']))!.unread).toBe(0)
  })

  it('restores the previous mailbox of every message on undo', async () => {
    await seed([
      ['a', INBOX],
      ['b', TRASH],
    ])
    const undo = await bulkMove(ACC, ['a', 'b'], INBOX)
    expect((await db.emails.get([ACC, 'b']))!.mailboxIds).toEqual([INBOX])

    await undo()
    // b came from trash and must go back there, not to the shared target.
    expect((await db.emails.get([ACC, 'b']))!.mailboxIds).toEqual([TRASH])
    expect((await db.emails.get([ACC, 'a']))!.mailboxIds).toEqual([INBOX])
  })

  /*
   * The derived folder index is only as good as the least careful writer, and
   * undo was exactly that: it rebuilt the row by hand and left `mailboxDates`
   * describing the folder the message had been moved *to*. Nothing threw — the
   * message simply stopped appearing in the folder it had been restored to.
   */
  it('keeps the derived folder index in step with a move and its undo', async () => {
    await seed([['a', INBOX]])
    /** Whether the row would be listed by a prefix scan of that folder. */
    const listedIn = async (mailboxId: string) => {
      const [from, to] = mailboxDateRange(mailboxId)
      const row = await db.emails.get([ACC, 'a'])
      return row!.mailboxDates.some((key) => key >= from && key <= to)
    }

    const undo = await bulkMove(ACC, ['a'], TRASH)
    expect(await listedIn(TRASH)).toBe(true)
    expect(await listedIn(INBOX)).toBe(false)

    await undo()
    expect(await listedIn(INBOX)).toBe(true)
    expect(await listedIn(TRASH)).toBe(false)
  })

  it('trashes what is outside trash and destroys what is already in it', async () => {
    await seed([
      ['keep', INBOX],
      ['gone', TRASH],
    ])
    await bulkDelete(ACC, ['keep', 'gone'])

    const destroy = enqueued.find((a) => a['kind'] === 'email.destroy')
    const update = enqueued.find((a) => a['kind'] === 'email.update')
    expect(destroy!['ids']).toEqual(['gone'])
    expect(Object.keys(update!['updates'] as object)).toEqual(['keep'])

    expect(await db.emails.get([ACC, 'gone'])).toBeUndefined()
    expect((await db.emails.get([ACC, 'keep']))!.mailboxIds).toEqual([TRASH])
  })

  it('does nothing at all for an empty selection', async () => {
    await seed([['a', INBOX]])
    await bulkSetKeyword(ACC, [], '$seen', true)
    expect(await bulkDelete(ACC, [])).toBeNull()
    expect(enqueued).toHaveLength(0)
  })
})
