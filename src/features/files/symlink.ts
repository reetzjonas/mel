/*
 * What a symlink says it points at.
 *
 * Showing, not following. The draft (draft-ietf-jmap-filenode) puts a target on
 * a symlink as path elements, where a leading empty element means the path is
 * absolute within the account and `..` steps up; the server does not check it,
 * so it may dangle. Resolving one would mean walking that path, guarding
 * against loops and refusing to leave the tree — and the server mel is built
 * against does not store symlinks at all, so none of that could be tried
 * against anything. See filenode.md.
 */

import type { FileNode } from '../../domain/file'

/**
 * The target as one readable path, or an em dash when there is none.
 *
 * A symlink whose target is missing is not an error worth a message of its own:
 * the row still says it is a link, and the dash says the server did not tell us
 * where to.
 */
export function symlinkPath(node: FileNode): string {
  const parts = node.target
  if (!parts || parts.length === 0) return '—'
  // A leading empty element is how the draft spells an absolute path, which
  // joins to exactly the leading slash a reader expects.
  return parts.join('/') || '/'
}
