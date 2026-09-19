import type { FileNode } from '../domain/file'
import {
  MAX_EMBEDDED_BYTES,
  decodeDataUri,
  embeddedLink,
  fileLink,
  type Attachment,
} from '../lib/attachments'
import { saveBlob } from '../lib/saveBlob'
import { connectionFor } from '../sync/connections'

/**
 * The link entry for a file taken from the device, its bytes embedded in the
 * event. Null when it is too big for that — the caller says so and points to
 * Files, which holds a reference instead of a copy.
 */
export async function embedFile(file: File): Promise<ReturnType<typeof embeddedLink> | null> {
  if (file.size > MAX_EMBEDDED_BYTES) return null
  return embeddedLink(
    file.name,
    file.type || 'application/octet-stream',
    new Uint8Array(await file.arrayBuffer()),
  )
}

/** The link entry for a file in Files, or null when the account has no Files or the node no content. */
export async function referenceFile(
  accountId: string,
  node: FileNode,
): Promise<ReturnType<typeof fileLink> | null> {
  const files = (await connectionFor(accountId)).files
  const href = files?.downloadHref(node)
  if (!href || !node.blobId) return null
  return fileLink({
    name: node.name,
    contentType: node.type ?? 'application/octet-stream',
    size: node.size,
    blobId: node.blobId,
    href,
  })
}

/**
 * Saves an attachment to disk. False when it could not be fetched — a file
 * that was edited or deleted in Files since the event was written, or a
 * connection that is down — so the dialog can say so instead of doing nothing.
 *
 * A web link is not handled here: it is an ordinary anchor.
 */
export async function saveAttachment(accountId: string, a: Attachment): Promise<boolean> {
  try {
    if (a.source === 'embedded') {
      const data = decodeDataUri(a.href)
      if (!data) return false
      saveBlob(new Blob([data.bytes as BlobPart], { type: a.contentType || data.type }), a.name)
      return true
    }
    if (a.source === 'file' && a.blobId) {
      const files = (await connectionFor(accountId)).files
      if (!files) return false
      saveBlob(await files.readBlob(a.blobId, a.contentType, a.name), a.name)
      return true
    }
  } catch {
    return false
  }
  return false
}
