/*
 * Note writes, offline-first — unlike the rest of the Files app.
 *
 * Files writes are server-first on purpose (`docs/notes/filenode.md`): an
 * upload has to reach the server to mean anything, and a queued one would park
 * a 50 MB payload in IndexedDB. A note is the opposite case. Jotting something
 * down on a train is the point of the feature, the payload is a few hundred
 * bytes of text, and a note that refuses to be written until the server
 * answers is a notebook that only works indoors.
 *
 * So a note lands locally first and an outbox action carries it over, with the
 * same retry and backoff every other queued write gets.
 */

import type { Note } from '../domain/note'
import { imageNames } from '../lib/noteFile'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { enqueue, type OutboxAction } from '../sync/outbox'
import { noteRow } from '../sync/notes'

/** Where a staged image waits for its upload, and where the editor finds it. */
export function stagedImageKey(noteId: string, name: string): string {
  return `note:${noteId}:${name}`
}

export function emptyNote(): Note {
  return {
    id: crypto.randomUUID(),
    folderId: null,
    fileId: null,
    folderName: '',
    title: '',
    body: '',
    pinned: false,
    due: null,
    linkedTo: null,
    extra: {},
    modified: '',
  }
}

/**
 * Write a note locally and queue the file write.
 *
 * The queued action carries only the note's id, never a copy of the note: an
 * editor saves on every pause, and a queue holding six snapshots of the same
 * note would write six versions of it in order, the last five of them
 * pointless. Reading the row when the action finally runs also means an edit
 * made while offline is the one that reaches the server, rather than whatever
 * the note looked like when the first save fired.
 */
export async function saveNote(accountId: string, note: Note): Promise<Note> {
  /*
   * An editor holds the note it was rendered with, which can predate the
   * moment the writer pinned a folder name or filled in where the note landed.
   * A note never loses its folder, so a copy without one is a stale copy: keep
   * what the row already knows rather than un-pinning it.
   */
  const stored = await db.notes.get([accountId, note.id])
  if (stored) {
    const known: Note = openEnvelope(stored.payload)
    note = {
      ...note,
      folderId: note.folderId ?? known.folderId,
      fileId: note.fileId ?? known.fileId,
      folderName: note.folderName || known.folderName,
    }
  }
  await db.notes.put(noteRow(accountId, note))
  /*
   * An untouched note is not worth a folder on the server. Pressing "new note"
   * and changing your mind would otherwise leave an empty one behind on every
   * device, and the folder is named after the title — which does not exist yet
   * at the moment the editor opens.
   */
  if (!note.title.trim() && !note.body.trim() && !note.folderId) return note
  if (!(await hasPendingSave(accountId, note.id))) {
    await enqueue(accountId, { kind: 'note.save', noteId: note.id })
  }
  return note
}

export async function deleteNote(accountId: string, note: Note): Promise<void> {
  await db.notes.delete([accountId, note.id])
  for (const name of imageNames(note.body)) {
    await db.blobCache.delete([accountId, stagedImageKey(note.id, name)])
  }
  // Nothing to tell the server about a note that never reached it — but the
  // save it is still waiting for has to go, or it would write the note back.
  await dropPendingSaves(accountId, note.id)
  if (!note.folderId) return
  await enqueue(accountId, { kind: 'note.destroy', folderId: note.folderId })
}

/**
 * Keep an image until the note it belongs to is written.
 *
 * The same trick compose uses for attachments (`stageAttachment`): the bytes
 * go into the blob cache under a key both the uploader and the editor can work
 * out, so the picture shows in the note straight away and is uploaded with the
 * next save. Images are separate files beside `note.md` rather than base64
 * inside it — a photo in the document would be re-read and re-uploaded every
 * time somebody fixed a typo.
 */
export async function stageNoteImage(
  accountId: string,
  noteId: string,
  file: File,
  usedNames: string[],
): Promise<string> {
  const name = uniqueName(file.name || 'image.png', usedNames)
  const data = await file.arrayBuffer()
  await db.blobCache.put({
    accountId,
    blobId: stagedImageKey(noteId, name),
    size: data.byteLength,
    lastAccess: Date.now(),
    payload: sealPlain({ type: file.type || 'application/octet-stream', data }),
  })
  return name
}

/** A name no other file in this note has, since the server refuses duplicates. */
function uniqueName(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}${ext}`
    if (!taken.includes(candidate)) return candidate
  }
}

async function pendingSaves(accountId: string, noteId: string) {
  const rows = await db.outbox.where('accountId').equals(accountId).toArray()
  return rows.filter((row) => {
    if (row.kind !== 'note.save' || row.status === 'failed') return false
    const action = openEnvelope(row.payload) as OutboxAction
    return action.kind === 'note.save' && action.noteId === noteId
  })
}

async function hasPendingSave(accountId: string, noteId: string): Promise<boolean> {
  return (await pendingSaves(accountId, noteId)).some((row) => row.status === 'pending')
}

async function dropPendingSaves(accountId: string, noteId: string): Promise<void> {
  for (const row of await pendingSaves(accountId, noteId)) {
    if (row.status !== 'inflight' && row.seq !== undefined) await db.outbox.delete(row.seq)
  }
}
