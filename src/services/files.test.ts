import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileNode } from '../domain/file'
import type { SetFailure } from '../providers/types'

const synced: string[] = []
vi.mock('../sync/engine', () => ({
  syncFileTree: (accountId: string) => {
    synced.push(accountId)
    return Promise.resolve()
  },
}))

/** Every destroy call the service made, in order. */
let destroyed: string[][] = []
let tree: FileNode[] = []
let destroyFailure: SetFailure | null = null
let created: Array<{ name: string; parentId: string | null; type: string }> = []
let hasProvider = true

const files = {
  syncNodes: () =>
    Promise.resolve({ created: tree, updated: [], destroyedIds: [], newState: 's', hasMore: false }),
  destroyNodes: (ids: string[]) => {
    destroyed.push(ids)
    return Promise.resolve(destroyFailure)
  },
  createFile: (f: { name: string; parentId: string | null; type: string }) => {
    created.push(f)
    return Promise.resolve({ id: 'new', failure: null })
  },
  createDirectory: () => Promise.resolve({ id: 'dir', failure: null }),
  editNode: () => Promise.resolve(null),
  readFile: () => Promise.resolve(new Blob(['content'])),
}

vi.mock('../sync/connections', () => ({
  connectionFor: () => Promise.resolve({ files: hasProvider ? files : null }),
}))

const { createFolder, deleteNodes, downloadNode, uploadFiles } = await import('./files')

const node = (id: string, parentId: string | null): FileNode => ({
  id,
  parentId,
  nodeType: parentId === null ? 'directory' : 'file',
  name: id,
  blobId: null,
  type: null,
  size: null,
  created: '2026-01-01T00:00:00Z',
  modified: '2026-01-01T00:00:00Z',
})

beforeEach(() => {
  destroyed = []
  created = []
  synced.length = 0
  destroyFailure = null
  hasProvider = true
  tree = []
})

describe('deleting a folder', () => {
  it('destroys the deepest level first, one call per level', async () => {
    /*
     * The server refuses a parent and its child in the same call — the child
     * comes back willDestroy and the parent nodeHasChildren — so the subtree
     * has to be taken apart from the leaves up.
     */
    tree = [node('root', null), node('mid', 'root'), node('leaf', 'mid'), node('other', null)]

    expect(await deleteNodes('acc', ['root'])).toBeNull()

    expect(destroyed).toEqual([['leaf'], ['mid'], ['root']])
  })

  it('leaves everything outside the subtree alone', async () => {
    tree = [node('root', null), node('child', 'root'), node('other', null)]

    await deleteNodes('acc', ['root'])

    expect(destroyed.flat()).not.toContain('other')
  })

  it('takes siblings at the same depth in one call', async () => {
    tree = [node('root', null), node('a', 'root'), node('b', 'root')]

    await deleteNodes('acc', ['a', 'b'])

    expect(destroyed).toHaveLength(1)
    expect(destroyed[0]!.sort()).toEqual(['a', 'b'])
  })

  it('reports the first refusal but still resyncs, so the tree is not left lying', async () => {
    tree = [node('root', null)]
    destroyFailure = { type: 'forbidden', permanent: true }

    expect(await deleteNodes('acc', ['root'])).toBe('forbidden')
    expect(synced).toEqual(['acc'])
  })
})

describe('uploading', () => {
  it('sends the files one after another into the folder', async () => {
    // The server's maxConcurrentUpload is commonly 2; firing a whole drop at
    // once earns a rate limit rather than a faster upload.
    await uploadFiles('acc', 'dir', [
      new File(['a'], 'a.txt', { type: 'text/plain' }),
      new File(['b'], 'b.txt', { type: 'text/plain' }),
    ])

    expect(created.map((f) => f.name)).toEqual(['a.txt', 'b.txt'])
    expect(created.every((f) => f.parentId === 'dir')).toBe(true)
  })

  it('gives a type to a file the browser could not identify', async () => {
    await uploadFiles('acc', null, [new File(['x'], 'mystery')])

    expect(created[0]!.type).toBe('application/octet-stream')
  })

  it('refreshes the local tree once, after the whole batch', async () => {
    await uploadFiles('acc', null, [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')])

    expect(synced).toEqual(['acc'])
  })
})

describe('reading a file', () => {
  it('hands back what the provider downloaded', async () => {
    const file = node('f', 'root')

    expect(await (await downloadNode('acc', file))!.text()).toBe('content')
  })

  it('has nothing to offer without a provider', async () => {
    hasProvider = false

    expect(await downloadNode('acc', node('f', 'root'))).toBeNull()
  })
})

describe('a server without file storage', () => {
  it('says so rather than pretending the write happened', async () => {
    hasProvider = false

    expect(await createFolder('acc', null, 'x')).toBe('noProvider')
    expect(synced).toEqual([])
  })
})
