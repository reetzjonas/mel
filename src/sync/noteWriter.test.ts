import { beforeEach, describe, expect, it } from 'vitest'
import type { FileNode } from '../domain/file'
import type { Note } from '../domain/note'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { stagedImageKey } from '../services/notes'
import { saveNoteFile } from './noteWriter'
import { noteRow, NOTE_FILE, NOTES_FOLDER } from './notes'

const ACC = 'acc-writer'

const node = (over: Partial<FileNode> & { id: string; name: string }): FileNode => ({
  parentId: null,
  nodeType: 'directory',
  blobId: null,
  type: null,
  size: null,
  target: null,
  executable: false,
  created: '2026-01-01T00:00:00Z',
  modified: '2026-01-01T00:00:00Z',
  ...over,
})

const note = (over: Partial<Note> = {}): Note => ({
  id: 'n1',
  folderId: null,
  fileId: null,
  folderName: '',
  title: 'Einkauf',
  body: '- [ ] Milch',
  pinned: false,
  due: null,
  linkedTo: null,
  extra: {},
  modified: '',
  ...over,
})

let children: Record<string, FileNode[]> = {}
let created: Array<{ name: string; parentId: string | null }> = []
let written: Array<{ id: string; text: string }> = []
let nextId = 0

const files = {
  listChildren: (parentId: string | null) => Promise.resolve(children[parentId ?? 'root'] ?? []),
  createDirectory: (name: string, parentId: string | null) => {
    created.push({ name, parentId })
    return Promise.resolve({ id: `dir-${++nextId}`, failure: null })
  },
  createFile: async (f: { name: string; parentId: string | null; data: Blob | ArrayBuffer }) => {
    created.push({ name: f.name, parentId: f.parentId })
    if (f.data instanceof Blob) written.push({ id: `file-${nextId}`, text: await f.data.text() })
    return { id: `file-${++nextId}`, failure: null }
  },
  writeFileContent: async (id: string, data: Blob) => {
    written.push({ id, text: await data.text() })
    return null
  },
} as never

beforeEach(async () => {
  await db.notes.clear()
  await db.blobCache.clear()
  children = {}
  created = []
  written = []
  nextId = 0
})

describe('writing a note that has never been saved', () => {
  it('makes the Notes folder, the note folder and the file', async () => {
    await db.notes.put(noteRow(ACC, note()))

    await saveNoteFile(ACC, files, 'n1')

    expect(created[0]!.name).toBe(NOTES_FOLDER)
    // Named after the title, at the moment it first has one.
    expect(created[1]!.name).toMatch(/^einkauf-[0-9a-f]{4}$/)
    expect(created[2]!.name).toBe(NOTE_FILE)
    expect(written[0]!.text).toContain('id: n1')
    expect(written[0]!.text).toContain('- [ ] Milch')
  })

  it('remembers where it landed, under the id the note already had', async () => {
    // The id never moves, so an editor open on this note goes on working.
    await db.notes.put(noteRow(ACC, note()))

    await saveNoteFile(ACC, files, 'n1')

    const stored: Note = openEnvelope((await db.notes.get([ACC, 'n1']))!.payload)
    expect(stored.id).toBe('n1')
    expect(stored.folderId).toBe('dir-2')
    expect(stored.fileId).toBe('file-3')
  })

  it('uses the folder that is already there rather than a second one', async () => {
    // What makes the queued action safe to replay: the first run may have
    // created the folder and then lost the answer.
    children['root'] = [node({ id: 'root-id', name: NOTES_FOLDER })]
    children['root-id'] = [node({ id: 'mine', name: 'einkauf-1a2b', parentId: 'root-id' })]
    await db.notes.put(noteRow(ACC, note({ folderName: 'einkauf-1a2b' })))

    await saveNoteFile(ACC, files, 'n1')

    expect(created.map((c) => c.name)).toEqual([NOTE_FILE])
  })
})

describe('writing a note that exists', () => {
  it('replaces the file in place rather than adding another', async () => {
    children['root'] = [node({ id: 'root-id', name: NOTES_FOLDER })]
    children['d1'] = [node({ id: 'f1', name: NOTE_FILE, parentId: 'd1', nodeType: 'file' })]
    await db.notes.put(noteRow(ACC, note({ folderId: 'd1', fileId: 'f1', title: 'Neu' })))

    await saveNoteFile(ACC, files, 'n1')

    expect(created).toEqual([])
    expect(written).toEqual([{ id: 'f1', text: expect.stringContaining('title: Neu') }])
  })

  it('does nothing at all for a note that was deleted while the write was queued', async () => {
    await saveNoteFile(ACC, files, 'gone')

    expect(created).toEqual([])
    expect(written).toEqual([])
  })
})

describe('the pictures a note refers to', () => {
  const withImage = () => note({ body: '![](foto.png)', folderId: 'd1', fileId: 'f1' })

  const stage = () =>
    db.blobCache.put({
      accountId: ACC,
      blobId: stagedImageKey('n1', 'foto.png'),
      size: 3,
      lastAccess: 0,
      payload: sealPlain({ type: 'image/png', data: new ArrayBuffer(3) }),
    })

  beforeEach(() => {
    children['root'] = [node({ id: 'root-id', name: NOTES_FOLDER })]
    children['d1'] = [node({ id: 'f1', name: NOTE_FILE, parentId: 'd1', nodeType: 'file' })]
  })

  it('uploads the staged copy and stops keeping it', async () => {
    await db.notes.put(noteRow(ACC, withImage()))
    await stage()

    await saveNoteFile(ACC, files, 'n1')

    expect(created.map((c) => c.name)).toEqual(['foto.png'])
    expect(await db.blobCache.count()).toBe(0)
  })

  it('leaves a picture that is already beside the note alone', async () => {
    children['d1']!.push(node({ id: 'i1', name: 'foto.png', parentId: 'd1', nodeType: 'file' }))
    await db.notes.put(noteRow(ACC, withImage()))
    await stage()

    await saveNoteFile(ACC, files, 'n1')

    expect(created).toEqual([])
  })

  it('ignores a reference with nothing staged and no file, rather than failing the save', async () => {
    // The text still says the picture is there; the note itself must not be
    // held hostage to a blob that has gone missing.
    await db.notes.put(noteRow(ACC, withImage()))

    await saveNoteFile(ACC, files, 'n1')

    expect(written).toHaveLength(1)
  })
})

describe('when the server refuses', () => {
  it('throws, so the queued write is retried rather than dropped', async () => {
    const refusing = {
      ...(files as object),
      createDirectory: () =>
        Promise.resolve({ id: null, failure: { type: 'overQuota', permanent: false } }),
    } as never
    await db.notes.put(noteRow(ACC, note()))

    await expect(saveNoteFile(ACC, refusing, 'n1')).rejects.toThrow('overQuota')
  })

  it('throws when the text itself could not be replaced', async () => {
    children['root'] = [node({ id: 'root-id', name: NOTES_FOLDER })]
    children['d1'] = [node({ id: 'f1', name: NOTE_FILE, parentId: 'd1', nodeType: 'file' })]
    const refusing = {
      ...(files as object),
      writeFileContent: () => Promise.resolve({ type: 'overQuota', permanent: false }),
    } as never
    await db.notes.put(noteRow(ACC, note({ folderId: 'd1', fileId: 'f1' })))

    await expect(saveNoteFile(ACC, refusing, 'n1')).rejects.toThrow('overQuota')
  })

  it('throws when a picture could not be uploaded, rather than writing a note that points at nothing', async () => {
    children['root'] = [node({ id: 'root-id', name: NOTES_FOLDER })]
    children['d1'] = [node({ id: 'f1', name: NOTE_FILE, parentId: 'd1', nodeType: 'file' })]
    const refusing = {
      ...(files as object),
      createFile: () =>
        Promise.resolve({ id: null, failure: { type: 'overQuota', permanent: false } }),
    } as never
    await db.notes.put(noteRow(ACC, note({ body: '![](foto.png)', folderId: 'd1', fileId: 'f1' })))
    await db.blobCache.put({
      accountId: ACC,
      blobId: stagedImageKey('n1', 'foto.png'),
      size: 3,
      lastAccess: 0,
      payload: sealPlain({ type: 'image/png', data: new ArrayBuffer(3) }),
    })

    await expect(saveNoteFile(ACC, refusing, 'n1')).rejects.toThrow('overQuota')
    // Still staged, so the retry has something to send.
    expect(await db.blobCache.count()).toBe(1)
  })

  it('carries a permanent refusal through as permanent', async () => {
    // The outbox marks those failed instead of retrying forever; a note it can
    // never write is worth saying out loud, not backing off about.
    children['root'] = [node({ id: 'root-id', name: NOTES_FOLDER })]
    const refusing = {
      ...(files as object),
      createFile: () =>
        Promise.resolve({
          id: null,
          failure: { type: 'forbidden', description: 'Read only', permanent: true },
        }),
    } as never
    await db.notes.put(noteRow(ACC, note({ folderId: 'd1' })))

    await expect(saveNoteFile(ACC, refusing, 'n1')).rejects.toMatchObject({ permanent: true })
  })
})
