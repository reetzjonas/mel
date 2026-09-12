import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailHeader } from '../domain/email'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
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

describe('marking messages read, unread and flagged', () => {
  beforeEach(() => {
    enqueued.length = 0
  })

  it('writes the change locally at once and queues it for the server', async () => {
    // Optimistic: the row has to change under the user's hand, with the
    // server told separately — the outbox is what makes that honest.
    await seed([['m1', INBOX]])

    await bulkSetKeyword(ACC, ['m1'], '$flagged', true)

    const row = await db.emails.get([ACC, 'm1'])
    expect(openEnvelope(row!.payload).keywords['$flagged']).toBe(true)
    // The flag also lives in an index column, or the "flagged only" filter
    // would not see it.
    expect(row!.flagged).toBe(1)
    expect(enqueued).toEqual([
      { kind: 'email.update', updates: { m1: { 'keywords/$flagged': true } } },
    ])
  })

  it('removes a keyword with null, not with false', async () => {
    // JMAP patches a keyword away by setting it to null; false would store
    // the key and leave the message looking flagged to anything reading it.
    await seed([['m1', INBOX]])
    await bulkSetKeyword(ACC, ['m1'], '$flagged', true)
    enqueued.length = 0

    await bulkSetKeyword(ACC, ['m1'], '$flagged', false)

    expect(enqueued).toEqual([
      { kind: 'email.update', updates: { m1: { 'keywords/$flagged': null } } },
    ])
    const row = await db.emails.get([ACC, 'm1'])
    expect('$flagged' in openEnvelope(row!.payload).keywords).toBe(false)
    expect(row!.flagged).toBe(0)
  })

  it('keeps the unread index column in step with $seen', async () => {
    // The folder's unread count and the bold rows both read this column, not
    // the payload.
    await seed([['m1', INBOX]])

    await bulkSetKeyword(ACC, ['m1'], '$seen', true)
    expect((await db.emails.get([ACC, 'm1']))!.unread).toBe(0)

    await bulkSetKeyword(ACC, ['m1'], '$seen', false)
    expect((await db.emails.get([ACC, 'm1']))!.unread).toBe(1)
  })

  it('puts every message of a selection in one queued action', async () => {
    await seed([
      ['m1', INBOX],
      ['m2', INBOX],
    ])

    await bulkSetKeyword(ACC, ['m1', 'm2'], '$seen', true)

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({
      updates: { m1: { 'keywords/$seen': true }, m2: { 'keywords/$seen': true } },
    })
  })

  it('offers no undo, unlike moving or deleting', async () => {
    /*
     * Deliberate, and worth pinning so nobody wires a snackbar expecting one:
     * read/unread and flag are undone by pressing the same control again,
     * while a move or a delete leaves nothing on screen to press. The bulk
     * move and delete paths do return an undo for that reason.
     */
    await seed([['m1', INBOX]])

    const result = await bulkSetKeyword(ACC, ['m1'], '$seen', true)

    expect(result).toBeUndefined()
  })

  it('does nothing for an empty selection', async () => {
    await seed([['m1', INBOX]])
    await bulkSetKeyword(ACC, [], '$seen', true)
    expect(enqueued).toEqual([])
  })
})
