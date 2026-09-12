import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailHeader } from '../domain/email'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { mailboxDateRange } from '../storage/emailRow'
import {
  archiveEmail,
  bulkDelete,
  bulkMove,
  bulkSetKeyword,
  deleteEmail,
  markNotSpam,
  moveEmail,
  setKeyword,
} from './mailActions'

const enqueued: Array<Record<string, unknown>> = []
vi.mock('../sync/outbox', () => ({
  enqueue: (_accountId: string, action: Record<string, unknown>) => {
    enqueued.push(action)
    return Promise.resolve(1)
  },
}))

/** What the server says when asked to create the Archive mailbox. */
let created: { id: string } | null = { id: 'mb-archive' }
const editMailbox = vi.fn(() => Promise.resolve(created))
vi.mock('../sync/connections', () => ({
  connectionFor: () => Promise.resolve({ mail: { editMailbox: () => editMailbox() } }),
}))
/** Standing in for the resync, which may make an Archive mailbox appear. */
let onSync: () => Promise<void> = () => Promise.resolve()
const syncAccount = vi.fn(() => onSync())
vi.mock('../sync/engine', () => ({ syncAccount: () => syncAccount() }))

const ACC = 'acc'
const INBOX = 'mb-inbox'
const TRASH = 'mb-trash'
const ARCHIVE = 'mb-archive'

const header = (id: string, mailboxIds: string[]): EmailHeader =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: Object.fromEntries(mailboxIds.map((m) => [m, true])),
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

async function putMailbox(id: string, role: string) {
  await db.mailboxes.put({
    accountId: ACC,
    id,
    role: role as never,
    parentId: null,
    sortOrder: 0,
    payload: sealPlain({ id, name: role, role, parentId: null } as never),
  })
}

/** Each message given the folder, or folders, it sits in. */
async function seed(ids: Array<[string, string | string[]]>) {
  await db.emails.clear()
  await db.mailboxes.clear()
  await db.bodyCache.clear()
  await putMailbox(INBOX, 'inbox')
  await putMailbox(TRASH, 'trash')
  for (const [id, where] of ids) {
    const mailboxIds = typeof where === 'string' ? [where] : where
    await db.emails.put({
      accountId: ACC,
      id,
      threadId: `t-${id}`,
      receivedAt: 0,
      mailboxIds,
      mailboxDates: [],
      unread: 1,
      flagged: 0,
      payload: sealPlain(header(id, mailboxIds)),
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

describe('acting on a single message', () => {
  beforeEach(() => {
    enqueued.length = 0
  })

  it('writes the keyword locally and queues the same patch', async () => {
    await seed([['m1', INBOX]])

    await setKeyword(ACC, 'm1', '$seen', true)

    expect((await db.emails.get([ACC, 'm1']))!.unread).toBe(0)
    expect(enqueued).toEqual([
      { kind: 'email.update', updates: { m1: { 'keywords/$seen': true } } },
    ])
  })

  it('replaces every folder the message was in, and puts them all back on undo', async () => {
    /*
     * A JMAP message can sit in several mailboxes at once, and a move replaces
     * the whole set. An undo that restored only the folder it was moved from
     * would quietly drop the others.
     */
    await seed([['m1', [INBOX, 'mb-label']]])

    const undo = await moveEmail(ACC, 'm1', TRASH)
    expect((await db.emails.get([ACC, 'm1']))!.mailboxIds).toEqual([TRASH])

    await undo()

    expect((await db.emails.get([ACC, 'm1']))!.mailboxIds.sort()).toEqual([INBOX, 'mb-label'])
    expect(enqueued.at(-1)).toEqual({
      kind: 'email.update',
      updates: { m1: { mailboxIds: { [INBOX]: true, 'mb-label': true } } },
    })
  })

  it('moves a message to trash, and destroys it when it is already there', async () => {
    await seed([
      ['keep', INBOX],
      ['gone', TRASH],
    ])
    await db.bodyCache.put({
      accountId: ACC,
      emailId: 'gone',
      lastAccess: 0,
      payload: sealPlain({} as never),
    })

    expect(await deleteEmail(ACC, 'keep')).toBeInstanceOf(Function)
    expect((await db.emails.get([ACC, 'keep']))!.mailboxIds).toEqual([TRASH])

    // The second press is the permanent one, so there is nothing left to undo.
    expect(await deleteEmail(ACC, 'gone')).toBeNull()
    expect(await db.emails.get([ACC, 'gone'])).toBeUndefined()
    // The cached body goes with it, or a deleted message keeps its text on disk.
    expect(await db.bodyCache.get([ACC, 'gone'])).toBeUndefined()
    expect(enqueued.at(-1)).toEqual({ kind: 'email.destroy', ids: ['gone'] })
  })

  it('destroys outright when the account has no trash at all', async () => {
    await seed([['m1', INBOX]])
    await db.mailboxes.delete([ACC, TRASH])

    expect(await deleteEmail(ACC, 'm1')).toBeNull()
    expect(enqueued.at(-1)).toEqual({ kind: 'email.destroy', ids: ['m1'] })
  })

  it('moves a message out of junk back to the inbox', async () => {
    await seed([['m1', 'mb-junk']])

    await markNotSpam(ACC, 'm1')

    expect((await db.emails.get([ACC, 'm1']))!.mailboxIds).toEqual([INBOX])
  })

  it('does nothing rather than guess when there is no inbox to return to', async () => {
    await seed([['m1', 'mb-junk']])
    await db.mailboxes.delete([ACC, INBOX])

    expect(await markNotSpam(ACC, 'm1')).toBeNull()
    expect(enqueued).toEqual([])
  })
})

describe('archiving when the server has no Archive mailbox', () => {
  beforeEach(async () => {
    enqueued.length = 0
    editMailbox.mockClear()
    syncAccount.mockClear()
    created = { id: ARCHIVE }
    onSync = () => Promise.resolve()
    await seed([['m1', INBOX]])
  })

  it('creates one and uses the id it got straight back', async () => {
    /*
     * Stalwart provisions no Archive mailbox, so the first archive has to make
     * one. Waiting for a full account sync to find its id afterwards is by far
     * the slowest thing in this path, and the move needs nothing else from it.
     */
    await archiveEmail(ACC, 'm1')

    expect(editMailbox).toHaveBeenCalledOnce()
    expect((await db.emails.get([ACC, 'm1']))!.mailboxIds).toEqual([ARCHIVE])
  })

  it('reuses the existing one instead of making a second', async () => {
    await putMailbox(ARCHIVE, 'archive')

    await archiveEmail(ACC, 'm1')

    expect(editMailbox).not.toHaveBeenCalled()
    expect((await db.emails.get([ACC, 'm1']))!.mailboxIds).toEqual([ARCHIVE])
  })

  it('looks again after a resync when the create came back empty', async () => {
    // Another client may have created the mailbox a moment earlier, in which
    // case the server refuses ours and the sync is what finds theirs.
    created = null
    onSync = () => putMailbox('mb-theirs', 'archive')

    await archiveEmail(ACC, 'm1')

    expect((await db.emails.get([ACC, 'm1']))!.mailboxIds).toEqual(['mb-theirs'])
  })

  it('reports failure rather than moving the message somewhere else', async () => {
    // The caller shows "archived" on a non-null answer; silently leaving the
    // message where it is while saying otherwise is the worse outcome.
    created = null

    expect(await archiveEmail(ACC, 'm1')).toBeNull()
    expect((await db.emails.get([ACC, 'm1']))!.mailboxIds).toEqual([INBOX])
    expect(enqueued).toEqual([])
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
