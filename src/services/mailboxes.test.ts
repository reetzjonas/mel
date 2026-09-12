import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mailbox } from '../domain/mailbox'
import type { MailboxEdit, SetFailure } from '../providers/types'

const edits: MailboxEdit[] = []
let failWith: (edit: MailboxEdit) => SetFailure | null = () => null
let serverTree: Mailbox[] = []
const syncAccount = vi.fn(async () => {})

vi.mock('../sync/connections', () => ({
  connectionFor: () =>
    Promise.resolve({
      mail: {
        editMailbox: (edit: MailboxEdit) => {
          edits.push(edit)
          return Promise.resolve({ id: 'new-id', failure: failWith(edit) })
        },
        syncMailboxes: () =>
          Promise.resolve({
            created: serverTree,
            updated: [],
            destroyedIds: [],
            newState: 's',
            hasMore: false,
          }),
      },
    }),
}))
vi.mock('../sync/engine', () => ({ syncAccount: () => syncAccount() }))

const { createMailbox, deleteMailbox, mailboxDeleteCost, moveMailbox, renameMailbox } =
  await import('./mailboxes')

const ACC = 'acc'

const box = (id: string, parentId: string | null, totalEmails = 0): Mailbox =>
  ({
    id,
    name: id,
    parentId,
    role: null,
    sortOrder: 0,
    totalEmails,
    unreadEmails: 0,
    mayAddItems: true,
    mayRename: true,
    mayDelete: true,
    mayCreateChild: true,
  }) as unknown as Mailbox

beforeEach(() => {
  edits.length = 0
  failWith = () => null
  serverTree = []
  syncAccount.mockClear()
})

describe('creating, renaming and moving a folder', () => {
  it('answers null when the server accepted it', () => {
    // The callers treat a string as "tell the user this went wrong", so
    // success has to be the absence of a message rather than an empty one.
    return expect(createMailbox(ACC, 'Rechnungen', null)).resolves.toBeNull()
  })

  it('syncs afterwards, so the sidebar shows what just happened', async () => {
    await createMailbox(ACC, 'Rechnungen', null)
    expect(syncAccount).toHaveBeenCalled()
  })

  it('re-parents to the top level with null rather than a sentinel', async () => {
    await moveMailbox(ACC, 'mb-1', null)
    expect(edits[0]).toEqual({ update: { id: 'mb-1', parentId: null } })
  })

  it('passes the server’s own words on when it refuses', async () => {
    failWith = () => ({
      type: 'invalidProperties',
      description: 'Name already taken',
      permanent: true,
    })
    await expect(renameMailbox(ACC, 'mb-1', 'Inbox')).resolves.toBe('Name already taken')
  })

  it('falls back to the error type when the server explains nothing', async () => {
    // Something the user can quote is better than a silent failure.
    failWith = () => ({ type: 'forbidden', permanent: true })
    await expect(renameMailbox(ACC, 'mb-1', 'x')).resolves.toBe('forbidden')
  })
})

describe('what deleting a folder will cost', () => {
  it('counts the whole subtree, and its mail, from the server', async () => {
    /*
     * From the server rather than the local mirror: a delete is refused
     * precisely because the server knows of a subfolder we do not, so asking
     * our own copy would answer the question that already went wrong.
     */
    serverTree = [box('a', null, 3), box('b', 'a', 5), box('c', 'b', 2), box('other', null, 99)]

    await expect(mailboxDeleteCost(ACC, 'a')).resolves.toEqual({ children: 2, mails: 10 })
  })

  it('reports nothing to take for an empty leaf', async () => {
    serverTree = [box('a', null, 0)]
    await expect(mailboxDeleteCost(ACC, 'a')).resolves.toEqual({ children: 0, mails: 0 })
  })
})

describe('deleting a folder', () => {
  it('tells the two refusals apart, so the UI can offer the way out', async () => {
    // "Delete the subfolders too" and "delete the mail too" are different
    // questions; the raw server message answers neither.
    failWith = () => ({ type: 'mailboxHasChild', permanent: true })
    await expect(deleteMailbox(ACC, 'a')).resolves.toMatchObject({ ok: false, blocker: 'hasChild' })

    failWith = () => ({ type: 'mailboxHasEmail', permanent: true })
    await expect(deleteMailbox(ACC, 'a')).resolves.toMatchObject({ ok: false, blocker: 'hasEmail' })

    failWith = () => ({ type: 'forbidden', permanent: true })
    await expect(deleteMailbox(ACC, 'a')).resolves.toMatchObject({ ok: false, blocker: 'other' })
  })

  it('takes the children deepest first, then the folder itself', async () => {
    // A parent cannot go while it still has children, so the order is the
    // whole of what makes a recursive delete work.
    serverTree = [box('a', null), box('b', 'a'), box('c', 'b')]

    await expect(deleteMailbox(ACC, 'a', { recursive: true })).resolves.toEqual({ ok: true })

    expect(edits.map((e) => e.destroy)).toEqual(['c', 'b', 'a'])
  })

  it('stops at the first child it cannot remove', async () => {
    // Carrying on would delete some of a folder the user still has, leaving
    // a half-emptied tree and a message saying it failed.
    serverTree = [box('a', null), box('b', 'a'), box('c', 'b')]
    failWith = (e) => (e.destroy === 'c' ? { type: 'forbidden', permanent: true } : null)

    const out = await deleteMailbox(ACC, 'a', { recursive: true })

    expect(out).toMatchObject({ ok: false, blocker: 'other' })
    expect(edits.map((e) => e.destroy)).toEqual(['c'])
  })

  it('carries the "with its mail" answer down to every child', async () => {
    serverTree = [box('a', null), box('b', 'a')]

    await deleteMailbox(ACC, 'a', { recursive: true, withEmails: true })

    expect(edits.every((e) => e.destroyWithEmails === true)).toBe(true)
  })
})
