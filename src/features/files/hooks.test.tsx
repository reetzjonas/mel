import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { FileNode } from '../../domain/file'
import { db } from '../../storage/db'
import { sealPlain } from '../../storage/envelope'
import { useFilePath, useFolderChildren } from './hooks'

const ACC = 'acc'

const node = (id: string, over: Partial<FileNode> = {}): FileNode => ({
  id,
  parentId: null,
  nodeType: 'file',
  name: id,
  blobId: null,
  type: null,
  size: 0,
  executable: false,
  created: '2026-01-01T00:00:00Z',
  modified: '2026-01-01T00:00:00Z',
  ...over,
})

async function store(n: FileNode) {
  await db.files.put({
    accountId: ACC,
    id: n.id,
    parentKey: n.parentId ?? '',
    nodeType: n.nodeType,
    payload: sealPlain(n),
  })
}

beforeEach(async () => {
  await db.files.where('accountId').equals(ACC).delete()
})

describe('listing a folder', () => {
  it('finds the nodes at the top level', async () => {
    /*
     * The reason parentKey exists: IndexedDB skips a record whose indexed key
     * is null, so storing the raw `parentId` would leave every root node out
     * of the index this query runs on and the root would always look empty.
     */
    await store(node('a'))
    await store(node('b', { parentId: 'a' }))

    const { result } = renderHook(() => useFolderChildren(ACC, null))

    await waitFor(() => expect(result.current?.map((n) => n.id)).toEqual(['a']))
  })

  it('finds the nodes inside a folder', async () => {
    await store(node('dir', { nodeType: 'directory' }))
    await store(node('inside', { parentId: 'dir' }))

    const { result } = renderHook(() => useFolderChildren(ACC, 'dir'))

    await waitFor(() => expect(result.current?.map((n) => n.id)).toEqual(['inside']))
  })

  it('puts folders before files and sorts each by name', async () => {
    await store(node('zebra.txt'))
    await store(node('apple.txt'))
    await store(node('Photos', { nodeType: 'directory' }))

    const { result } = renderHook(() => useFolderChildren(ACC, null))

    await waitFor(() =>
      expect(result.current?.map((n) => n.name)).toEqual(['Photos', 'apple.txt', 'zebra.txt']),
    )
  })
})

describe('the breadcrumb trail', () => {
  it('reads from the root down to the folder', async () => {
    await store(node('top', { nodeType: 'directory' }))
    await store(node('mid', { nodeType: 'directory', parentId: 'top' }))
    await store(node('deep', { nodeType: 'directory', parentId: 'mid' }))

    const { result } = renderHook(() => useFilePath(ACC, 'deep'))

    await waitFor(() => expect(result.current?.map((n) => n.id)).toEqual(['top', 'mid', 'deep']))
  })

  it('stops at a parent that has not synced yet rather than giving up', async () => {
    // A partly synced tree should show a short trail, not an empty one.
    await store(node('child', { nodeType: 'directory', parentId: 'absent' }))

    const { result } = renderHook(() => useFilePath(ACC, 'child'))

    await waitFor(() => expect(result.current?.map((n) => n.id)).toEqual(['child']))
  })

  it('does not spin on a parent chain that points at itself', async () => {
    // Never seen from a server, but a cycle here would hang the render.
    await store(node('loop', { nodeType: 'directory', parentId: 'loop' }))

    const { result } = renderHook(() => useFilePath(ACC, 'loop'))

    await waitFor(() => expect(result.current?.map((n) => n.id)).toEqual(['loop']))
  })
})
