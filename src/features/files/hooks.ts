import { useLiveQuery } from 'dexie-react-hooks'
import type { FileNode } from '../../domain/file'
import { db } from '../../storage/db'
import { openEnvelope } from '../../storage/envelope'

/** Folders before files, then by name — the order every file manager uses. */
function inListingOrder(a: FileNode, b: FileNode): number {
  const dir = (n: FileNode) => (n.nodeType === 'directory' ? 0 : 1)
  return dir(a) - dir(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

export function useFolderChildren(
  accountId: string | undefined,
  parentId: string | null,
): FileNode[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId) return []
    // The empty string is how a top-level node is keyed; see FileNodeRow.
    const rows = await db.files
      .where('[accountId+parentKey]')
      .equals([accountId, parentId ?? ''])
      .toArray()
    return rows.map((r) => openEnvelope(r.payload)).sort(inListingOrder)
  }, [accountId, parentId])
}

/** Every node in the account, for working out where a move may land. */
export function useAllNodes(accountId: string | undefined): FileNode[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId) return []
    const rows = await db.files.where('accountId').equals(accountId).toArray()
    return rows.map((r) => openEnvelope(r.payload)).sort(inListingOrder)
  }, [accountId])
}

export function useFileNode(
  accountId: string | undefined,
  id: string | null,
): FileNode | null | undefined {
  return useLiveQuery(async () => {
    if (!accountId || !id) return null
    const row = await db.files.get([accountId, id])
    return row ? openEnvelope(row.payload) : null
  }, [accountId, id])
}

/**
 * The folders from the root down to `id`, for the breadcrumb.
 *
 * Walks parent by parent and stops on a parent that is not stored locally,
 * so a tree that synced only in part shows a short trail rather than nothing.
 */
export function useFilePath(
  accountId: string | undefined,
  id: string | null,
): FileNode[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId || !id) return []
    const trail: FileNode[] = []
    const seen = new Set<string>()
    let at: string | null = id
    while (at !== null && !seen.has(at)) {
      seen.add(at)
      const row = await db.files.get([accountId, at])
      if (!row) break
      const node: FileNode = openEnvelope(row.payload)
      trail.unshift(node)
      at = node.parentId
    }
    return trail
  }, [accountId, id])
}
