// Provider-agnostic file storage model, from JMAP FileNode
// (draft-ietf-jmap-filenode). Nothing in src/domain may import from
// src/providers — the dependency points the other way.

export type FileNodeType = 'file' | 'directory' | 'symlink'

/** Standard top-level folder roles from draft-ietf-jmap-filenode. */
export type FileNodeRole =
  | 'root'
  | 'home'
  | 'temp'
  | 'trash'
  | 'documents'
  | 'downloads'
  | 'music'
  | 'pictures'
  | 'videos'
  | null

export interface FileNode {
  id: string
  /** null for a node at the top level of the account. */
  parentId: string | null
  /** A server-designated top-level folder, or null for an ordinary node. */
  role?: FileNodeRole
  nodeType: FileNodeType
  /** Unique among its siblings; the server rejects duplicates. */
  name: string
  /**
   * Content of a file, null for a directory.
   *
   * Server-assigned: it is not the blob id returned by the upload that
   * supplied the content, so reading a file back must use this value.
   */
  blobId: string | null
  /** Media type of a file, null for a directory. */
  type: string | null
  /**
   * Where a symlink points, as path elements; null for anything else.
   *
   * The draft's own shape: a leading empty element makes the path absolute
   * within the account, `..` steps up, and the target need not exist — dangling
   * links are allowed. mel shows it and never follows it; see filenode.md.
   */
  target: string[] | null
  /** Size of a file in bytes, null for a directory. */
  size: number | null
  /**
   * Whether the file may be run, for a store that is also mounted somewhere.
   *
   * Meaningless inside a browser — nothing here executes anything — but the
   * bit survives a round trip through mel rather than being quietly dropped
   * when the same tree is a folder on a machine as well.
   */
  executable: boolean
  /** ISO 8601 UTC. */
  created: string
  modified: string
}
