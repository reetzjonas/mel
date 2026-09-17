import { beforeEach, describe, expect, it } from 'vitest'
import type { FileNode } from '../domain/file'
import type { Note } from '../domain/note'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { fileTree, noteAttachments, noteRow, readNotes, NOTE_FILE, NOTES_FOLDER } from './notes'

const ACC = 'acc-notes'

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
  folderId: 'd1',
  fileId: 'f1',
  folderName: 'einkauf-1a2b',
  title: 'Einkauf',
  body: '',
  pinned: false,
  due: null,
  linkedTo: null,
  extra: {},
  modified: '2026-01-01T00:00:00Z',
  ...over,
})

/** The tree a written note makes: Notes / <note> / note.md. */
function tree(fileModified = '2026-01-01T00:00:00Z'): FileNode[] {
  return [
    node({ id: 'root', name: NOTES_FOLDER }),
    node({ id: 'd1', name: 'einkauf-1a2b', parentId: 'root' }),
    node({
      id: 'f1',
      name: NOTE_FILE,
      parentId: 'd1',
      nodeType: 'file',
      blobId: 'b1',
      type: 'text/markdown',
      modified: fileModified,
    }),
  ]
}

let read: string[] = []
let contents = '---\nid: n1\ntitle: Einkauf\n---\n\n- [ ] Milch'

const files = {
  readFile: (n: FileNode) => {
    read.push(n.id)
    return Promise.resolve(new Blob([contents]))
  },
} as never

beforeEach(async () => {
  await db.notes.clear()
  await db.files.clear()
  read = []
  contents = '---\nid: n1\ntitle: Einkauf\n---\n\n- [ ] Milch'
})

describe('reading the notes folder', () => {
  it('takes the note id from the file, not from the folder it happens to be in', async () => {
    await readNotes(ACC, tree(), files)

    const row = await db.notes.get([ACC, 'n1'])
    expect(openEnvelope(row!.payload)).toMatchObject({
      id: 'n1',
      folderId: 'd1',
      fileId: 'f1',
      title: 'Einkauf',
    })
  })

  it('does not read a blob for a note whose file has not changed', async () => {
    await readNotes(ACC, tree(), files)
    expect(read).toEqual(['f1'])

    await readNotes(ACC, tree(), files)
    expect(read).toEqual(['f1'])
  })

  it('reads it again once the file node says it moved', async () => {
    await readNotes(ACC, tree(), files)
    contents = '---\nid: n1\ntitle: Einkauf, neu\n---\n\n- [x] Milch'

    await readNotes(ACC, tree('2026-02-02T00:00:00Z'), files)

    const row = await db.notes.get([ACC, 'n1'])
    expect(openEnvelope(row!.payload).title).toBe('Einkauf, neu')
  })

  it('ignores a folder that has no note in it', async () => {
    // The Notes folder is an ordinary folder any client can write to; whatever
    // else lands there is not a note with no text.
    const stray = [
      node({ id: 'root', name: NOTES_FOLDER }),
      node({ id: 'd9', name: 'holiday pics', parentId: 'root' }),
    ]

    await readNotes(ACC, stray, files)

    expect(await db.notes.count()).toBe(0)
  })

  it('drops a note whose folder is gone from the server', async () => {
    await readNotes(ACC, tree(), files)

    await readNotes(ACC, [node({ id: 'root', name: NOTES_FOLDER })], files)

    expect(await db.notes.get([ACC, 'n1'])).toBeUndefined()
  })

  it('keeps a note that has never been written', async () => {
    // Jotted down offline: there is no folder for it yet, and its queued save
    // is what will make one. Dropping it here would throw the text away.
    await db.notes.put(noteRow(ACC, note({ id: 'fresh', folderId: null, fileId: null })))

    await readNotes(ACC, [node({ id: 'root', name: NOTES_FOLDER })], files)

    expect(await db.notes.get([ACC, 'fresh'])).toBeDefined()
  })

  it('leaves the note it already has when the file cannot be read', async () => {
    // Offline mid-sync, or a blob the server no longer serves: the last text
    // that was read is better than none.
    await readNotes(ACC, tree(), files)
    const failing = { readFile: () => Promise.resolve(null) } as never

    await readNotes(ACC, tree('2026-03-03T00:00:00Z'), failing)

    const row = await db.notes.get([ACC, 'n1'])
    expect(openEnvelope(row!.payload).title).toBe('Einkauf')
  })

  it('has nothing to do before the folder exists', async () => {
    await readNotes(ACC, [], files)

    expect(read).toEqual([])
    expect(await db.notes.count()).toBe(0)
  })
})

describe('the files beside a note', () => {
  it('are everything in its folder but the note itself', async () => {
    const nodes = [
      ...tree(),
      node({ id: 'i1', name: 'foto.png', parentId: 'd1', nodeType: 'file' }),
      node({ id: 'other', name: 'stray.txt', parentId: 'elsewhere', nodeType: 'file' }),
    ]

    expect(noteAttachments(nodes, 'd1').map((n) => n.name)).toEqual(['foto.png'])
  })
})

describe('the account file tree', () => {
  it('comes back decoded, whoever wrote the rows', async () => {
    for (const n of tree()) {
      await db.files.put({
        accountId: ACC,
        id: n.id,
        parentKey: n.parentId ?? '',
        nodeType: n.nodeType,
        payload: sealPlain(n),
      })
    }

    expect((await fileTree(ACC)).map((n) => n.name).sort()).toEqual(
      [NOTES_FOLDER, NOTE_FILE, 'einkauf-1a2b'].sort(),
    )
  })
})
