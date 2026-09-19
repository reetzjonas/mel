import type { FileNode } from '../../domain/file'

/**
 * Pure tree arithmetic over a flat node list — no Dexie, no provider.
 *
 * Both callers need the same descendant walk: deleting has to take a subtree
 * apart leaf-first, and a move has to refuse the destinations that sit inside
 * what is being moved.
 */

/** The given nodes plus everything beneath them. */
export function withDescendants(all: FileNode[], roots: string[]): Set<string> {
  const childrenOf = new Map<string, FileNode[]>()
  for (const n of all) {
    const key = n.parentId ?? ''
    childrenOf.set(key, [...(childrenOf.get(key) ?? []), n])
  }
  const out = new Set<string>()
  const walk = (id: string) => {
    if (out.has(id)) return
    out.add(id)
    for (const child of childrenOf.get(id) ?? []) walk(child.id)
  }
  for (const id of roots) walk(id)
  return out
}

/** Ids grouped by depth, deepest level first. */
export function deepestFirst(all: FileNode[], ids: Set<string>): string[][] {
  const parentOf = new Map(all.map((n) => [n.id, n.parentId]))
  const depth = (id: string) => {
    let d = 0
    const seen = new Set<string>([id])
    for (let p = parentOf.get(id); p != null && !seen.has(p); p = parentOf.get(p)) {
      seen.add(p)
      d++
    }
    return d
  }
  const levels = new Map<number, string[]>()
  for (const id of ids) {
    const d = depth(id)
    levels.set(d, [...(levels.get(d) ?? []), id])
  }
  return [...levels.entries()].sort((a, b) => b[0] - a[0]).map(([, list]) => list)
}

/**
 * Mel's own internal files — `.mel/settings.json`, so far — live under a
 * dotfile-named folder so the browser can leave them out of an ordinary
 * listing by convention, the same one a desktop file manager uses. Never
 * truly hidden: `FileBrowser.tsx`'s "Show hidden files" toggle reveals them.
 */
export function isHidden(node: FileNode): boolean {
  return node.name.startsWith('.')
}

/** Whether a node is the given folder or is nested below it. */
export function isInFolder(all: FileNode[], id: string | null, folderId: string): boolean {
  const parentOf = new Map(all.map((n) => [n.id, n.parentId]))
  const seen = new Set<string>()
  for (let at = id; at !== null && !seen.has(at); at = parentOf.get(at) ?? null) {
    if (at === folderId) return true
    seen.add(at)
  }
  return false
}

/**
 * Where the given nodes may be moved to.
 *
 * A folder cannot move into itself or into anything beneath it — the server
 * would be left holding a cycle with no path to the root. The folder the
 * nodes are already in is dropped too, since moving them there is a no-op the
 * server would answer with an error about a duplicate name. A hidden folder
 * is never offered either, regardless of the browser's own toggle — nobody
 * is meant to file something into `.mel/` by hand.
 */
export function moveTargets(
  all: FileNode[],
  moving: string[],
  currentParentId: string | null,
): FileNode[] {
  const blocked = withDescendants(all, moving)
  return all.filter(
    (n) =>
      n.nodeType === 'directory' && !blocked.has(n.id) && n.id !== currentParentId && !isHidden(n),
  )
}
