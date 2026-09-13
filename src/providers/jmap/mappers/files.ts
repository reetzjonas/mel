import type { FileNode, FileNodeType } from '../../../domain/file'

// FileNode objects as served by draft-ietf-jmap-filenode. Only what we use;
// the spec also carries target, accessed, executable, isSubscribed, myRights,
// shareWith and role.

export interface JmapFileNode {
  id: string
  parentId?: string | null
  nodeType?: string | null
  name?: string | null
  blobId?: string | null
  type?: string | null
  size?: number | null
  created?: string | null
  modified?: string | null
}

const NODE_TYPES: readonly string[] = ['file', 'directory', 'symlink']

/**
 * An unknown nodeType becomes 'file' rather than being dropped.
 *
 * The list is open to registration, so a node type we have never heard of is
 * not a protocol error — and a node missing from the tree would be worse than
 * one shown with the wrong icon.
 */
function toNodeType(v: string | null | undefined): FileNodeType {
  return NODE_TYPES.includes(v ?? '') ? (v as FileNodeType) : 'file'
}

export function toFileNode(n: JmapFileNode): FileNode {
  const created = n.created ?? ''
  return {
    id: n.id,
    parentId: n.parentId ?? null,
    nodeType: toNodeType(n.nodeType),
    name: n.name ?? '',
    blobId: n.blobId ?? null,
    type: n.type ?? null,
    size: typeof n.size === 'number' ? n.size : null,
    created,
    // The spec lets a client leave modified unset; fall back to created so
    // sorting by it never has to deal with a hole.
    modified: n.modified ?? created,
  }
}
