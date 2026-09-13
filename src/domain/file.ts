// Provider-agnostic file storage model, from JMAP FileNode
// (draft-ietf-jmap-filenode). Nothing in src/domain may import from
// src/providers — the dependency points the other way.

export type FileNodeType = 'file' | 'directory' | 'symlink'

export interface FileNode {
  id: string
  /** null for a node at the top level of the account. */
  parentId: string | null
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
  /** Size of a file in bytes, null for a directory. */
  size: number | null
  /** ISO 8601 UTC. */
  created: string
  modified: string
}
