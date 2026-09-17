/*
 * Keeping the notes read model in step with the files the notes actually are.
 *
 * FileNode carries no room for a note's own fields — a node has a name, a
 * size, a type and two timestamps — so the list cannot be drawn from the tree
 * alone. Every note's text is read once into `db.notes`, and read again only
 * when the file node's `modified` has moved. That is the same delta the file
 * tree already syncs, so nothing here asks the server anything the Files app
 * was not going to ask anyway.
 */

import type { FileNode } from '../domain/file'
import type { Note } from '../domain/note'
import { parseNote } from '../lib/noteFile'
import type { FilesProvider } from '../providers/types'
import { db, type NoteRow } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'

/** The folder notes live in, at the top level of the account. */
export const NOTES_FOLDER = 'Notes'
/** The one file that makes a folder a note. */
export const NOTE_FILE = 'note.md'
/** What a note file is written as; a plain text type, readable anywhere. */
export const NOTE_TYPE = 'text/markdown'

export function noteRow(accountId: string, note: Note): NoteRow {
  return {
    accountId,
    id: note.id,
    pinned: note.pinned ? 1 : 0,
    modified: note.modified,
    payload: sealPlain(note),
  }
}

/** Every file node of the account, decoded. */
export async function fileTree(accountId: string): Promise<FileNode[]> {
  const rows = await db.files.where('accountId').equals(accountId).toArray()
  return rows.map((r) => openEnvelope(r.payload))
}

/** The Notes folder, if the account has one yet. */
export function notesRoot(nodes: FileNode[]): FileNode | undefined {
  return nodes.find(
    (n) => n.parentId === null && n.nodeType === 'directory' && n.name === NOTES_FOLDER,
  )
}

/**
 * A note's folder and its `note.md`, for every note under the root.
 *
 * A folder without a `note.md` is not a note: the Notes folder is an ordinary
 * folder that any client can write to, and something else that ends up in
 * there should be left alone rather than shown as an empty note.
 */
export function noteFolders(
  nodes: FileNode[],
  rootId: string,
): Array<{ folder: FileNode; file: FileNode }> {
  const out: Array<{ folder: FileNode; file: FileNode }> = []
  for (const folder of nodes) {
    if (folder.parentId !== rootId || folder.nodeType !== 'directory') continue
    const file = nodes.find(
      (n) => n.parentId === folder.id && n.nodeType === 'file' && n.name === NOTE_FILE,
    )
    if (file) out.push({ folder, file })
  }
  return out
}

/** Files sitting beside a note, which is where its images are. */
export function noteAttachments(nodes: FileNode[], folderId: string): FileNode[] {
  return nodes.filter(
    (n) => n.parentId === folderId && n.nodeType === 'file' && n.name !== NOTE_FILE,
  )
}

/**
 * Read the notes folder into `db.notes`.
 *
 * Called after the file tree has synced — on its own it would work from a
 * stale tree and miss exactly the note that just changed.
 */
export async function reconcileNotes(accountId: string, files: FilesProvider): Promise<void> {
  await readNotes(accountId, await fileTree(accountId), files)
}

export async function readNotes(
  accountId: string,
  nodes: FileNode[],
  files: FilesProvider,
): Promise<void> {
  const rows = await db.notes.where('accountId').equals(accountId).toArray()
  const known = new Map(rows.map((r) => [r.id, openEnvelope(r.payload)]))

  const root = notesRoot(nodes)
  const found = root ? noteFolders(nodes, root.id) : []
  const seen = new Set<string>()

  for (const { folder, file } of found) {
    // The file node's timestamp is the whole cache key: unchanged means the
    // text cannot have changed either, whoever wrote it. The id is inside the
    // file, so a note whose folder has not moved is matched without a read.
    const unchanged = [...known.values()].find(
      (n) => n.folderId === folder.id && n.fileId === file.id && n.modified === file.modified,
    )
    if (unchanged) {
      seen.add(unchanged.id)
      continue
    }
    const blob = await files.readFile(file)
    if (!blob) {
      /*
       * A blob that will not come right now — offline mid-sync, a server
       * hiccup — is not a deleted note. Without counting it as seen, the pass
       * below would take the last text that *was* read away as well, and the
       * note would vanish from the list while its folder sits on the server.
       */
      const existing = [...known.values()].find((n) => n.folderId === folder.id)
      if (existing) seen.add(existing.id)
      continue
    }
    const note = parseNote(await blob.text(), {
      folderId: folder.id,
      fileId: file.id,
      folderName: folder.name,
      modified: file.modified,
    })
    seen.add(note.id)
    await db.notes.put(noteRow(accountId, note))
  }

  /*
   * Rows whose folder is gone go too — but never a note that has not been
   * written yet. One jotted down offline has no folder on the server, and its
   * outbox action is what will create it; deleting it here would throw away
   * what somebody just wrote.
   */
  for (const row of rows) {
    const note = known.get(row.id)
    if (seen.has(row.id) || !note?.folderId) continue
    await db.notes.delete([accountId, row.id])
  }
}
