/*
 * Putting a note on the server: the half of the note flow that talks to it.
 *
 * Kept out of `outbox.ts` because it is the longest single action there is —
 * a note is a folder, a Markdown file and any number of images — and out of
 * `services/notes.ts` because that half must never touch the network.
 *
 * Every step finds its target before writing it, so running the whole thing
 * twice lands in the same place: a folder is looked up by name before it is
 * created, the file by the folder it sits in, and an image is skipped if a
 * file of that name is already there. That is what makes the queued action
 * safe to replay after a tab was closed mid-flight.
 */

import type { FileNode } from '../domain/file'
import type { Note } from '../domain/note'
import { imageNames, noteFolderName, serializeNote } from '../lib/noteFile'
import type { FilesProvider, SetFailure } from '../providers/types'
import { db } from '../storage/db'
import { openEnvelope } from '../storage/envelope'
import { stagedImageKey } from '../services/notes'
import { NOTE_FILE, NOTE_TYPE, NOTES_FOLDER, noteRow } from './notes'

function fail(failure: SetFailure): Error {
  return Object.assign(new Error(failure.description ?? failure.type), {
    permanent: failure.permanent,
  })
}

/**
 * Find a child directory by name, or make it.
 *
 * Exported for `settingsWriter.ts`, which needs the same find-or-create for
 * `.mel/` — the small internal-files folder settings sync writes into.
 */
export async function findOrCreateFolder(
  files: FilesProvider,
  parentId: string | null,
  name: string,
): Promise<string> {
  const existing = (await files.listChildren(parentId)).find(
    (n) => n.nodeType === 'directory' && n.name === name,
  )
  if (existing) return existing.id
  const created = await files.createDirectory(name, parentId)
  if (created.failure || !created.id)
    throw fail(created.failure ?? { type: 'serverFail', permanent: false })
  return created.id
}

/**
 * Write the note that is in the local store under this id.
 *
 * Nothing happens if the row is gone — the note was deleted while its save
 * was still queued, and writing it back would resurrect it.
 */
export async function saveNoteFile(
  accountId: string,
  files: FilesProvider,
  noteId: string,
): Promise<void> {
  const row = await db.notes.get([accountId, noteId])
  if (!row) return
  const note: Note = openEnvelope(row.payload)

  const rootId = await findOrCreateFolder(files, null, NOTES_FOLDER)
  /*
   * The folder is named here rather than when the note was created, because
   * this is the first moment it has a title to be named after. It is named
   * once and then left alone: renaming it on every title change would be a
   * second write that can fail on its own, for a name only a file browser
   * ever sees.
   */
  const folderName = note.folderName || noteFolderName(note.title)
  /*
   * Pinned before anything is created. The name carries a random suffix, so a
   * replay after a lost answer — the tab closed between the folder and the
   * file — would look for a name it has never used, miss the folder the first
   * run made, and leave it empty behind a second one. The title may well have
   * changed by then, too.
   */
  if (!note.folderName && !note.folderId) await pinFolderName(accountId, noteId, folderName)
  const folderId = note.folderId ?? (await findOrCreateFolder(files, rootId, folderName))
  const children = await files.listChildren(folderId)

  await uploadImages(accountId, files, note, folderId, children)

  const text = new Blob([serializeNote(note)], { type: NOTE_TYPE })
  const existing = children.find((c) => c.nodeType === 'file' && c.name === NOTE_FILE)
  let fileId = existing?.id ?? null
  if (existing) {
    const failure = await files.writeFileContent(existing.id, text, NOTE_TYPE)
    if (failure) throw fail(failure)
  } else {
    const created = await files.createFile({
      name: NOTE_FILE,
      parentId: folderId,
      data: text,
      type: NOTE_TYPE,
    })
    if (created.failure) throw fail(created.failure)
    fileId = created.id
  }

  /*
   * Where it landed, written back under the same id it already had. The id
   * belongs to the note and never moves, so an editor open on it now points at
   * a note that knows its folder — no navigation, no remount, no lost
   * keystroke.
   */
  const current = await db.notes.get([accountId, noteId])
  if (current) {
    const latest: Note = openEnvelope(current.payload)
    await db.notes.put(noteRow(accountId, { ...latest, folderId, fileId, folderName }))
  }
}

async function pinFolderName(accountId: string, noteId: string, folderName: string) {
  const current = await db.notes.get([accountId, noteId])
  if (!current) return
  const latest: Note = openEnvelope(current.payload)
  if (latest.folderName) return
  await db.notes.put(noteRow(accountId, { ...latest, folderName }))
}

/**
 * Upload the images this note refers to that are not beside it yet.
 *
 * The body is the list: a picture nobody wrote into the text is not part of
 * the note, and one that is already a file in the folder needs nothing. The
 * staged copy is dropped only once the upload is through, so a failure leaves
 * the picture where the editor can still show it.
 */
async function uploadImages(
  accountId: string,
  files: FilesProvider,
  note: Note,
  folderId: string,
  children: FileNode[],
): Promise<void> {
  for (const name of imageNames(note.body)) {
    if (children.some((c) => c.name === name)) continue
    const key = stagedImageKey(note.id, name)
    const cached = await db.blobCache.get([accountId, key])
    if (!cached) continue
    const { data, type } = openEnvelope(cached.payload) as { data: ArrayBuffer; type: string }
    const created = await files.createFile({ name, parentId: folderId, data, type })
    if (created.failure) throw fail(created.failure)
    await db.blobCache.delete([accountId, key])
  }
}
