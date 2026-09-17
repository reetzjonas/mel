import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Note } from '../domain/note'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'

const queued: Array<{ kind: string; noteId?: string; folderId?: string }> = []
vi.mock('../sync/outbox', () => ({
  enqueue: (accountId: string, action: { kind: string }) => {
    queued.push(action as never)
    return db.outbox.add({
      accountId,
      kind: action.kind,
      status: 'pending',
      attempts: 0,
      notBefore: 0,
      payload: sealPlain(action),
    })
  },
}))

const { deleteNote, emptyNote, saveNote, stageNoteImage, stagedImageKey } = await import('./notes')

const ACC = 'acc-notes'

const note = (over: Partial<Note> = {}): Note => ({ ...emptyNote(), ...over })

beforeEach(async () => {
  await db.notes.clear()
  await db.outbox.clear()
  await db.blobCache.clear()
  queued.length = 0
})

describe('saving a note', () => {
  it('writes it locally and queues the file write', async () => {
    const n = note({ title: 'Einkauf' })

    await saveNote(ACC, n)

    expect(openEnvelope((await db.notes.get([ACC, n.id]))!.payload).title).toBe('Einkauf')
    expect(queued).toEqual([{ kind: 'note.save', noteId: n.id }])
  })

  it('leaves an untouched note off the server entirely', async () => {
    // "New note" and a change of mind should not litter every device with an
    // empty folder — and there is no title yet to name one after.
    await saveNote(ACC, note())

    expect(queued).toEqual([])
    expect(await db.notes.count()).toBe(1)
  })

  it('queues one write however often the editor saves', async () => {
    // The editor saves on every pause. Six snapshots of the same note would be
    // six writes of which the first five are already out of date.
    const n = note({ title: 'a' })
    await saveNote(ACC, n)
    await saveNote(ACC, { ...n, title: 'ab' })
    await saveNote(ACC, { ...n, title: 'abc' })

    expect(queued).toHaveLength(1)
    expect(openEnvelope((await db.notes.get([ACC, n.id]))!.payload).title).toBe('abc')
  })
})

describe('a save that failed for good', () => {
  it('does not stop the next edit being queued', async () => {
    // A failed row sits in the queue until it is dealt with by hand. Treating
    // it as "already queued" would mean nothing this note is given ever goes.
    const n = note({ title: 'x' })
    await saveNote(ACC, n)
    const [row] = await db.outbox.toArray()
    await db.outbox.update(row!.seq!, { status: 'failed' })
    queued.length = 0

    await saveNote(ACC, { ...n, title: 'xy' })

    expect(queued).toEqual([{ kind: 'note.save', noteId: n.id }])
  })
})

describe('deleting a note', () => {
  it('queues the folder for destruction once the note has one', async () => {
    const n = note({ title: 'x', folderId: 'd1' })
    await saveNote(ACC, n)
    queued.length = 0

    await deleteNote(ACC, n)

    expect(await db.notes.get([ACC, n.id])).toBeUndefined()
    expect(queued).toEqual([{ kind: 'note.destroy', folderId: 'd1' }])
  })

  it('tells the server nothing about a note it never had', async () => {
    const n = note({ title: 'x' })
    await saveNote(ACC, n)

    await deleteNote(ACC, n)

    // The queued save goes too, or it would write the note straight back.
    expect(await db.outbox.count()).toBe(0)
    expect(queued.filter((a) => a.kind === 'note.destroy')).toEqual([])
  })

  it('takes the pictures that were waiting with it', async () => {
    const n = note({ title: 'x', body: '![](a.png)' })
    await db.blobCache.put({
      accountId: ACC,
      blobId: stagedImageKey(n.id, 'a.png'),
      size: 1,
      lastAccess: 0,
      payload: sealPlain({ type: 'image/png', data: new ArrayBuffer(1) }),
    })

    await deleteNote(ACC, n)

    expect(await db.blobCache.count()).toBe(0)
  })
})

describe('staging a picture', () => {
  it('keeps the bytes where the editor and the uploader both look', async () => {
    const n = note()
    const file = new File([new Uint8Array([1, 2, 3])], 'foto.png', { type: 'image/png' })

    const name = await stageNoteImage(ACC, n.id, file, [])

    expect(name).toBe('foto.png')
    const cached = await db.blobCache.get([ACC, stagedImageKey(n.id, 'foto.png')])
    expect(openEnvelope(cached!.payload).type).toBe('image/png')
  })

  it('gives a second picture of the same name one of its own', async () => {
    // The server refuses two children with the same name, and "image.png" is
    // what half the pictures on a phone are called.
    const n = note()
    const file = new File(['x'], 'foto.png', { type: 'image/png' })

    expect(await stageNoteImage(ACC, n.id, file, ['foto.png'])).toBe('foto-2.png')
    expect(await stageNoteImage(ACC, n.id, file, ['foto.png', 'foto-2.png'])).toBe('foto-3.png')
  })

  it('names a file the browser gave no name at all', async () => {
    const n = note()

    expect(await stageNoteImage(ACC, n.id, new File(['x'], ''), [])).toBe('image.png')
  })
})
