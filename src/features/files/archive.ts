/*
 * Packing a selection of nodes into one zip.
 *
 * A browser can only be handed one file at a time, and a folder not at all —
 * so downloading six files means six separate "keep/discard" prompts, and
 * downloading a folder means nothing happens. Both become one archive here.
 *
 * The path maths is separated from the zip writing because only the first
 * needs testing against awkward trees, and only the second needs a library.
 */

import type { FileNode } from '../../domain/file'

export interface ArchiveEntry {
  /** Where it lands inside the archive; a trailing slash marks a directory. */
  path: string
  node: FileNode
}

/**
 * Every node the selection actually puts in the archive, with its path.
 *
 * Folders are walked, so selecting one brings everything under it. A node with
 * no content is skipped — a directory unless it is empty (an empty folder is
 * still worth keeping, and only the entry itself can carry it), and a symlink
 * always, since the target is a property mel does not read (#77) and a stored
 * symlink would otherwise become a silently empty file.
 *
 * Names cannot collide: the server keeps them unique among siblings, and a
 * selection is always made within one listing.
 */
export function archiveEntries(all: FileNode[], ids: string[]): ArchiveEntry[] {
  const children = new Map<string, FileNode[]>()
  for (const node of all) {
    if (node.parentId === null) continue
    const siblings = children.get(node.parentId)
    if (siblings) siblings.push(node)
    else children.set(node.parentId, [node])
  }

  const out: ArchiveEntry[] = []
  const walk = (node: FileNode, prefix: string) => {
    const path = prefix ? `${prefix}/${node.name}` : node.name
    if (node.nodeType === 'directory') {
      const kids = children.get(node.id) ?? []
      if (kids.length === 0) out.push({ path: `${path}/`, node })
      else for (const kid of kids) walk(kid, path)
      return
    }
    if (node.blobId) out.push({ path, node })
  }

  const byId = new Map(all.map((n) => [n.id, n]))
  for (const id of ids) {
    const node = byId.get(id)
    if (node) walk(node, '')
  }
  return out
}

/**
 * What the zip file is called.
 *
 * One folder on its own keeps its name — that is what was asked for. Anything
 * else is named after the folder it came from, since "three things out of
 * Invoices" has no better name than "Invoices".
 */
export function archiveName(selected: FileNode[], folderName: string): string {
  const only = selected.length === 1 ? selected[0] : undefined
  const base = only && only.nodeType === 'directory' ? only.name : folderName
  return `${base}.zip`
}

/**
 * Types worth compressing.
 *
 * Deflate runs on the main thread here, so it is spent only where it pays:
 * text shrinks by two thirds, and a JPEG or a PDF is already compressed and
 * would cost a pause for a percent. fflate's async path would move the work
 * off-thread, but it builds a Worker out of a blob URL — an avoidable
 * dependency on a CSP that allows that.
 */
const COMPRESSIBLE = /^(text\/|image\/svg|application\/(json|xml|javascript|x-sh|x-tar))/

/**
 * Write the entries as a zip, reading each file's content as it goes.
 *
 * Streamed rather than collected: entries are pushed one at a time and the
 * output is kept as chunks, so peak memory is the archive plus whichever file
 * is in hand, not every file at once. A file that cannot be read is written
 * empty rather than dropped, so the archive still says it was there.
 */
export async function writeArchive(
  entries: ArchiveEntry[],
  read: (node: FileNode) => Promise<Blob | null>,
): Promise<Blob> {
  const { Zip, ZipDeflate, ZipPassThrough } = await import('fflate')

  const chunks: Uint8Array[] = []
  let settle: (err?: unknown) => void = () => {}
  const closed = new Promise<void>((resolve, reject) => {
    settle = (err) => (err ? reject(err) : resolve())
  })

  const zip = new Zip((err, data, final) => {
    if (err) {
      settle(err)
      return
    }
    chunks.push(data)
    if (final) settle()
  })

  for (const entry of entries) {
    const type = entry.node.type ?? ''
    const file =
      entry.path.endsWith('/') || !COMPRESSIBLE.test(type)
        ? new ZipPassThrough(entry.path)
        : new ZipDeflate(entry.path, { level: 6 })
    const mtime = Date.parse(entry.node.modified)
    if (!Number.isNaN(mtime)) file.mtime = mtime

    const blob = entry.path.endsWith('/') ? null : await read(entry.node)
    zip.add(file)
    file.push(blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(), true)
  }

  zip.end()
  await closed
  return new Blob(chunks as BlobPart[], { type: 'application/zip' })
}
