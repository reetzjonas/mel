import type { FileNode } from '../domain/file'
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
  const doomed = new Set<string>()
  const collect = (id: string) => {
    if (doomed.has(id)) return
    doomed.add(id)
    for (const child of all.filter((n) => n.parentId === id)) collect(child.id)
  }
  for (const id of ids) collect(id)

  let failed: string | null = null
  for (const level of byDepth(all, doomed)) {
    const failure = await files.destroyNodes(level)
    if (failure && !failed) failed = message(failure)
  }
  await syncFileTree(accountId)
  return failed
}

/** The doomed ids grouped deepest-first, so no call holds a node and its parent. */
function byDepth(all: FileNode[], doomed: Set<string>): string[][] {
  const parentOf = new Map(all.map((n) => [n.id, n.parentId]))
  const depth = (id: string): number => {
    let d = 0
    for (let p = parentOf.get(id); p != null; p = parentOf.get(p)) d++
    return d
  }
  const levels = new Map<number, string[]>()
  for (const id of doomed) {
    const d = depth(id)
    levels.set(d, [...(levels.get(d) ?? []), id])
  }
  return [...levels.entries()].sort((a, b) => b[0] - a[0]).map(([, ids]) => ids)
}

export async function downloadNode(accountId: string, node: FileNode): Promise<Blob | null> {
  const files = await provider(accountId)
  return files ? files.readFile(node) : null
}
