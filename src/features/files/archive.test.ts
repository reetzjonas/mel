import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { FileNode } from '../../domain/file'
import { archiveEntries, archiveName, writeArchive } from './archive'

function node(part: Partial<FileNode> & { id: string; name: string }): FileNode {
  return {
    parentId: null,
    nodeType: 'file',
    blobId: `blob-${part.id}`,
    type: 'text/plain',
    size: 1,
    executable: false,
    created: '2026-01-01T00:00:00Z',
    modified: '2026-01-01T00:00:00Z',
    ...part,
  }
}

const tree: FileNode[] = [
  node({ id: 'd1', name: 'docs', nodeType: 'directory', blobId: null, type: null, size: null }),
  node({ id: 'f1', name: 'notes.txt', parentId: 'd1' }),
  node({ id: 'd2', name: 'images', nodeType: 'directory', parentId: 'd1', blobId: null }),
  node({ id: 'f2', name: 'cat.png', parentId: 'd2', type: 'image/png' }),
  node({ id: 'f3', name: 'loose.txt' }),
]

describe('archiveEntries', () => {
  it('walks a selected folder into paths under its own name', () => {
    expect(archiveEntries(tree, ['d1']).map((e) => e.path)).toEqual([
      'docs/notes.txt',
      'docs/images/cat.png',
    ])
  })

  it('takes a file next to a folder at the top of the archive', () => {
    expect(archiveEntries(tree, ['f3', 'd2']).map((e) => e.path)).toEqual([
      'loose.txt',
      'images/cat.png',
    ])
  })

  it('keeps an empty folder as a folder entry', () => {
    // Nothing else can carry it: a zip without the entry is a zip where the
    // folder simply never existed.
    const empty = [node({ id: 'd9', name: 'later', nodeType: 'directory', blobId: null })]
    expect(archiveEntries(empty, ['d9'])).toEqual([{ path: 'later/', node: empty[0] }])
  })

  it('leaves out a node with no content', () => {
    // A symlink, whose target is a property mel does not read — writing it as
    // a zero-byte file would claim the content was empty rather than elsewhere.
    const link = [node({ id: 's1', name: 'shortcut', nodeType: 'symlink', blobId: null })]
    expect(archiveEntries(link, ['s1'])).toEqual([])
  })

  it('ignores an id that is not in the tree', () => {
    expect(archiveEntries(tree, ['gone'])).toEqual([])
  })
})

describe('archiveName', () => {
  it('names a lone folder after itself', () => {
    expect(archiveName([tree[0]!], 'Files')).toBe('docs.zip')
  })

  it('names any other selection after the folder it came from', () => {
    expect(archiveName([tree[4]!], 'Invoices')).toBe('Invoices.zip')
    expect(archiveName([tree[0]!, tree[4]!], 'Invoices')).toBe('Invoices.zip')
  })
})

describe('writeArchive', () => {
  it('writes a zip a zip reader can open again', async () => {
    const entries = archiveEntries(tree, ['d1', 'f3'])
    const blob = await writeArchive(entries, async (n) => new Blob([`content of ${n.name}`]))

    const unpacked = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    expect(Object.keys(unpacked).sort()).toEqual([
      'docs/images/cat.png',
      'docs/notes.txt',
      'loose.txt',
    ])
    expect(strFromU8(unpacked['docs/notes.txt']!)).toBe('content of notes.txt')
  })

  it('writes a file it cannot read as an empty one rather than dropping it', async () => {
    // Half an archive that says so beats a whole one that quietly lost a file.
    const blob = await writeArchive(archiveEntries(tree, ['f3']), async () => null)

    const unpacked = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    expect(unpacked['loose.txt']).toEqual(new Uint8Array())
  })
})
