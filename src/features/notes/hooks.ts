import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import type { Note } from '../../domain/note'
import { db } from '../../storage/db'
import { openEnvelope } from '../../storage/envelope'
import { stagedImageKey } from '../../services/notes'
import { connectionFor } from '../../sync/connections'
import { fileTree, noteAttachments } from '../../sync/notes'

/**
 * Pinned first, then most recently changed.
 *
 * A note still waiting to be written has no timestamp from the server yet, and
 * belongs at the top: it is the one just typed.
 */
function inListOrder(a: Note, b: Note): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  const at = a.modified || '9999'
  const bt = b.modified || '9999'
  return bt.localeCompare(at)
}

export function useNotes(accountId: string | undefined): Note[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId) return []
    const rows = await db.notes.where('accountId').equals(accountId).toArray()
    return rows.map((r) => openEnvelope(r.payload)).sort(inListOrder)
  }, [accountId])
}

export function useNote(accountId: string | undefined, id: string | undefined): Note | undefined {
  return useLiveQuery(async () => {
    if (!accountId || !id) return undefined
    const row = await db.notes.get([accountId, id])
    return row ? openEnvelope(row.payload) : undefined
  }, [accountId, id])
}

/**
 * URLs for the pictures a note refers to, wherever each of them currently is.
 *
 * One just added has only been staged locally; one from a note that synced is
 * a file beside `note.md` on the server. Both end up as object URLs, revoked
 * together when the note is closed — the same ownership rule the file preview
 * follows.
 */
export function useNoteImages(
  accountId: string | undefined,
  note: Note | undefined,
  names: string[],
): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const noteId = note?.id
  const folderId = note?.folderId
  const modified = note?.modified
  // The list as one value, so the effect does not re-run on every render just
  // because the caller built a new array of the same names.
  const key = names.join('\u0000')

  useEffect(() => {
    if (!accountId || !noteId) return
    const wanted = key ? key.split('\u0000') : []
    const made: string[] = []
    let cancelled = false

    const load = async () => {
      const nodes = folderId ? noteAttachments(await fileTree(accountId), folderId) : []
      const files = folderId ? (await connectionFor(accountId)).files : null
      const found: Record<string, string> = {}
      for (const name of wanted) {
        const staged = await db.blobCache.get([accountId, stagedImageKey(noteId, name)])
        let blob: Blob | null = null
        if (staged) {
          const { data, type } = openEnvelope(staged.payload) as { data: ArrayBuffer; type: string }
          blob = new Blob([data], { type })
        } else {
          const node = nodes.find((n) => n.name === name)
          blob = node && files ? await files.readFile(node) : null
        }
        if (!blob) continue
        const url = URL.createObjectURL(blob)
        made.push(url)
        found[name] = url
      }
      if (cancelled) {
        for (const url of made) URL.revokeObjectURL(url)
        return
      }
      setUrls(found)
    }
    void load().catch(() => {})

    return () => {
      cancelled = true
      for (const url of made) URL.revokeObjectURL(url)
    }
    // `modified` is in here so a picture replaced on the server is fetched
    // again rather than left as the copy this tab happens to hold.
  }, [accountId, noteId, folderId, key, modified])

  return urls
}
