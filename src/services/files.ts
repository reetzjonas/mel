import type { FileNode } from '../domain/file'
import { archiveEntries, writeArchive } from '../features/files/archive'
import { deepestFirst, withDescendants } from '../features/files/tree'
import type { FilesProvider, SetFailure } from '../providers/types'
import { connectionFor } from '../sync/connections'
import { syncFileTree } from '../sync/engine'

/**
 * File writes, all of them server-first.
 *
 * Mail, contacts and calendar write locally and queue an outbox action. Files
 * do not, for two reasons: the content has to reach the server for the write
 * to mean anything at all, and a queued upload would have to park the whole
 * file in IndexedDB — a 50 MB payload in a table built for `keywords/$seen`
 * patches. So these report failure to the caller instead of retrying later,
 * and the local mirror catches up through syncFileTree().
 */

const message = (f: SetFailure | null): string | null => (f ? (f.description ?? f.type) : null)

async function provider(accountId: string): Promise<FilesProvider | null> {
  return (await connectionFor(accountId)).files
}

/** Run a write, then let the local tree catch up with what the server did. */
async function write(
  accountId: string,
  op: (files: FilesProvider) => Promise<SetFailure | null>,
): Promise<string | null> {
  const files = await provider(accountId)
  if (!files) return 'noProvider'
  const failure = await op(files)
  await syncFileTree(accountId)
  return message(failure)
}

export function createFolder(
  accountId: string,
  parentId: string | null,
  name: string,
): Promise<string | null> {
  return write(accountId, async (files) => (await files.createDirectory(name, parentId)).failure)
}

export function renameNode(accountId: string, id: string, name: string): Promise<string | null> {
  return write(accountId, (files) => files.editNode(id, { name }))
}

/**
 * Set or clear the executable bit.
 *
 * Nothing in a browser runs a file, so this exists for the other end: a store
 * that is also a mounted folder somewhere, where a script that arrived without
 * the bit cannot be run until someone sets it.
 */
export function setExecutable(
  accountId: string,
  id: string,
  executable: boolean,
): Promise<string | null> {
  return write(accountId, (files) => files.editNode(id, { executable }))
}

/**
 * Re-parent nodes; `null` moves them to the top level.
 *
 * One request per node — there is no batched re-parent — and the first
 * refusal is what gets reported, but the rest are still attempted: a name
 * that collides in the destination should not strand the others where they
 * were.
 */
export async function moveNodes(
  accountId: string,
  ids: string[],
  parentId: string | null,
): Promise<string | null> {
  const files = await provider(accountId)
  if (!files) return 'noProvider'
  let failed: string | null = null
  for (const id of ids) {
    const failure = await files.editNode(id, { parentId })
    if (failure && !failed) failed = message(failure)
  }
  await syncFileTree(accountId)
  return failed
}

/**
 * Upload files into a folder, reporting the first one that fails.
 *
 * Sequential rather than parallel: a multi-file drop is the normal case, and
 * the server's maxConcurrentUpload is frequently 2 — firing twenty at once
 * earns a rate limit rather than a faster upload.
 */
export async function uploadFiles(
  accountId: string,
  parentId: string | null,
  incoming: File[],
): Promise<string | null> {
  const files = await provider(accountId)
  if (!files) return 'noProvider'
  let failed: string | null = null
  for (const file of incoming) {
    const r = await files.createFile({
      name: file.name,
      parentId,
      data: file,
      type: file.type || 'application/octet-stream',
    })
    if (r.failure && !failed) failed = message(r.failure)
  }
  await syncFileTree(accountId)
  return failed
}

/**
 * Delete nodes, descending into folders first.
 *
 * The server takes one level at a time — a parent and its child in the same
 * call fails both — so the subtree is walked deepest-first. The tree comes
 * from the server rather than the local mirror for the same reason the folder
 * delete does: a stale local copy would miss exactly the child that blocks it.
 */
export async function deleteNodes(accountId: string, ids: string[]): Promise<string | null> {
  const files = await provider(accountId)
  if (!files) return 'noProvider'
  const all = (await files.syncNodes()).created

  const trash = all.find((node) => node.role === 'trash' && node.nodeType === 'directory')
  const parentOf = new Map(all.map((node) => [node.id, node.parentId]))
  const isInTrash = (id: string) => {
    const seen = new Set<string>()
    for (let at: string | null = id; at !== null && !seen.has(at); at = parentOf.get(at) ?? null) {
      if (at === trash?.id) return true
      seen.add(at)
    }
    return false
  }

  // A Trash turns delete into a reversible re-parent. Nodes already there, and
  // the Trash itself, retain the explicit permanent-delete behavior. Split a
  // mixed root selection so choosing Trash alongside another folder cannot
  // accidentally destroy the other folder too.
  const toTrash = trash ? ids.filter((id) => id !== trash.id && !isInTrash(id)) : []
  const toDestroy = ids.filter((id) => !toTrash.includes(id))
  if (trash && toTrash.length) {
    let failed: string | null = null
    for (const id of toTrash) {
      const failure = await files.editNode(id, { parentId: trash.id })
      if (failure && !failed) failed = message(failure)
    }
    for (const level of deepestFirst(all, withDescendants(all, toDestroy))) {
      const failure = await files.destroyNodes(level)
      if (failure && !failed) failed = message(failure)
    }
    await syncFileTree(accountId)
    return failed
  }

  let failed: string | null = null
  for (const level of deepestFirst(all, withDescendants(all, toDestroy))) {
    const failure = await files.destroyNodes(level)
    if (failure && !failed) failed = message(failure)
  }
  await syncFileTree(accountId)
  return failed
}

export async function downloadNode(accountId: string, node: FileNode): Promise<Blob | null> {
  const files = await provider(accountId)
  return files ? files.readFile(node) : null
}

/**
 * Pack a selection — files, folders, or both — into one zip.
 *
 * The tree comes from the server rather than the local mirror, for the same
 * reason the recursive delete does: a stale copy would miss exactly the child
 * that matters, and here that means quietly leaving a file out of an archive
 * somebody is about to keep.
 *
 * Null with no error means there was nothing to pack — an empty selection, or
 * one holding only nodes with no content.
 */
export async function packArchive(
  accountId: string,
  ids: string[],
): Promise<{ blob: Blob | null; error: string | null }> {
  const files = await provider(accountId)
  if (!files) return { blob: null, error: 'noProvider' }
  const all = (await files.syncNodes()).created
  const entries = archiveEntries(all, ids)
  if (!entries.length) return { blob: null, error: null }
  return { blob: await writeArchive(entries, (node) => files.readFile(node)), error: null }
}
