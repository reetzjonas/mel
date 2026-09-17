import { describe, expect, it, vi } from 'vitest'
import type { FileNode } from '../../domain/file'
import { CannotCalculateChanges } from '../types'
import { createJmapFiles } from './files'
import type { Transport } from './client/transport'
import type { Invocation, JmapRequest } from './client/types/core'

const UPLOAD = 'https://example.test/upload/{accountId}/'
const DOWNLOAD = 'https://example.test/download/{accountId}/{blobId}/{name}?accept={type}'

/**
 * A transport answering each call by its method name, so a test names what
 * the server says rather than counting positions in an array.
 */
function serverAnswering(
  byName: Record<string, unknown | unknown[]>,
  uploadBlobId = 'uploaded-blob',
) {
  const sent: JmapRequest[] = []
  const taken: Record<string, number> = {}
  const fetchRaw = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve({
      url,
      init,
      json: () => Promise.resolve({ blobId: uploadBlobId, size: 3 }),
      blob: () => Promise.resolve(new Blob(['body'])),
    } as unknown as Response),
  )
  const transport = {
    request: (req: JmapRequest) => {
      sent.push(req)
      const responses: Invocation[] = req.methodCalls.map(([name, , callId]) => {
        const answer = byName[name]
        const value = Array.isArray(answer)
          ? answer[(taken[name] = (taken[name] ?? 0) + 1) - 1]
          : answer
        if (value && typeof value === 'object' && 'error' in (value as object)) {
          return ['error', (value as { error: unknown }).error as never, callId]
        }
        return [name, (value ?? {}) as never, callId]
      })
      return Promise.resolve({ methodResponses: responses, sessionState: 's' })
    },
    fetchRaw,
  } as unknown as Transport
  return { provider: createJmapFiles(transport, 'acc', UPLOAD, DOWNLOAD), sent, fetchRaw }
}

const node = (over: Partial<FileNode> = {}): FileNode => ({
  id: 'f1',
  parentId: null,
  nodeType: 'file',
  name: 'settings.json',
  blobId: 'stored-blob',
  type: 'application/json',
  size: 3,
  executable: false,
  created: '2026-01-01T00:00:00Z',
  modified: '2026-01-01T00:00:00Z',
  ...over,
})

describe('syncing the file tree', () => {
  it('asks for everything the first time and reports it as created', async () => {
    const { provider, sent } = serverAnswering({
      'FileNode/get': { list: [{ id: 'f1', name: 'a.txt', nodeType: 'file' }], state: 's1' },
    })

    const page = await provider.syncNodes(undefined)

    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({ ids: null })
    expect(page).toMatchObject({ newState: 's1', hasMore: false })
    expect(page.created.map((n) => n.name)).toEqual(['a.txt'])
  })

  it('asks only for what changed afterwards', async () => {
    const { provider, sent } = serverAnswering({
      'FileNode/changes': {
        created: ['new'],
        updated: ['old'],
        destroyed: ['gone'],
        newState: 's2',
        hasMoreChanges: false,
      },
      'FileNode/get': [
        { list: [{ id: 'new' }], state: 's2' },
        { list: [{ id: 'old' }], state: 's2' },
      ],
    })

    const page = await provider.syncNodes('s1')

    expect(sent).toHaveLength(1)
    expect(page).toMatchObject({ destroyedIds: ['gone'], newState: 's2' })
    expect(page.created.map((n) => n.id)).toEqual(['new'])
    expect(page.updated.map((n) => n.id)).toEqual(['old'])
  })

  it('raises a forgotten state as its own kind of failure', async () => {
    const { provider } = serverAnswering({
      'FileNode/changes': { error: { type: 'cannotCalculateChanges' } },
      'FileNode/get': { list: [], state: 's' },
    })

    await expect(provider.syncNodes('ancient')).rejects.toBeInstanceOf(CannotCalculateChanges)
  })
})

describe('listing a directory', () => {
  it('filters on the parent and fetches the nodes in the same request', async () => {
    const { provider, sent } = serverAnswering({
      'FileNode/query': { ids: ['f1'] },
      'FileNode/get': { list: [{ id: 'f1', name: 'a.txt' }], state: 's' },
    })

    const children = await provider.listChildren('dir-1')

    expect(sent).toHaveLength(1)
    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({ filter: { parentId: 'dir-1' } })
    expect(children.map((n) => n.name)).toEqual(['a.txt'])
  })

  it('asks for isTopLevel rather than a null parent at the root', async () => {
    // `parentId: null` is a different condition and the server refuses it.
    const { provider, sent } = serverAnswering({
      'FileNode/query': { ids: [] },
      'FileNode/get': { list: [], state: 's' },
    })

    await provider.listChildren(null)

    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({ filter: { isTopLevel: true } })
  })
})

describe('creating nodes', () => {
  it('answers with the id the server assigned to a directory', async () => {
    const { provider, sent } = serverAnswering({
      'FileNode/set': { created: { d0: { id: 'dir-id' } } },
    })

    await expect(provider.createDirectory('notes', null)).resolves.toEqual({
      id: 'dir-id',
      failure: null,
    })
    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({
      create: { d0: { name: 'notes', parentId: null, nodeType: 'directory' } },
    })
  })

  it('uploads the content first and points the new file at that blob', async () => {
    const { provider, sent, fetchRaw } = serverAnswering(
      { 'FileNode/set': { created: { f0: { id: 'file-id' } } } },
      'fresh-blob',
    )

    const result = await provider.createFile({
      name: 'settings.json',
      parentId: 'dir-1',
      data: new Blob(['{}']),
      type: 'application/json',
    })

    expect(result).toEqual({ id: 'file-id', failure: null })
    expect(fetchRaw.mock.calls[0]![0]).toBe('https://example.test/upload/acc/')
    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({
      create: { f0: { blobId: 'fresh-blob', nodeType: 'file', type: 'application/json' } },
    })
  })

  it('reports a file the server refused, having already spent the upload', async () => {
    const { provider } = serverAnswering({
      'FileNode/set': { notCreated: { f0: { type: 'alreadyExists' } } },
    })

    await expect(
      provider.createFile({
        name: 'settings.json',
        parentId: null,
        data: new Blob(['{}']),
        type: 'application/json',
      }),
    ).resolves.toMatchObject({ id: null, failure: { type: 'alreadyExists', permanent: true } })
  })

  it('reports a name the server refuses as permanent, so it is not retried', async () => {
    const { provider } = serverAnswering({
      'FileNode/set': {
        notCreated: { d0: { type: 'alreadyExists', description: 'taken' } },
      },
    })

    await expect(provider.createDirectory('notes', null)).resolves.toEqual({
      id: null,
      failure: { type: 'alreadyExists', description: 'taken', permanent: true },
    })
  })

  it('treats a server failure as worth retrying', async () => {
    const { provider } = serverAnswering({
      'FileNode/set': { notCreated: { d0: { type: 'serverFail' } } },
    })

    const { failure } = await provider.createDirectory('notes', null)

    expect(failure).toMatchObject({ type: 'serverFail', permanent: false })
  })
})

describe('changing a node', () => {
  it('uploads new content and updates the blob the file points at', async () => {
    const { provider, sent } = serverAnswering(
      { 'FileNode/set': { updated: { f1: null } } },
      'next-blob',
    )

    await expect(
      provider.writeFileContent('f1', new Blob(['{}']), 'application/json'),
    ).resolves.toBeNull()
    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({
      update: { f1: { blobId: 'next-blob', type: 'application/json' } },
    })
  })

  it('renames and moves in one update', async () => {
    const { provider, sent } = serverAnswering({ 'FileNode/set': { updated: { f1: null } } })

    await provider.editNode('f1', { name: 'renamed.json', parentId: 'dir-2' })

    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({
      update: { f1: { name: 'renamed.json', parentId: 'dir-2' } },
    })
  })

  it('passes a refused update back to the caller', async () => {
    const { provider } = serverAnswering({
      'FileNode/set': { notUpdated: { f1: { type: 'forbidden' } } },
    })

    await expect(provider.editNode('f1', { name: 'x' })).resolves.toMatchObject({
      type: 'forbidden',
      permanent: true,
    })
  })
})

describe('destroying nodes', () => {
  it('reports a non-empty directory as a permanent failure', async () => {
    // The server refuses a parent whose children are still there, and refuses
    // it again when they are destroyed in the same call.
    const { provider } = serverAnswering({
      'FileNode/set': {
        notDestroyed: { d1: { type: 'nodeHasChildren', description: 'not empty' } },
      },
    })

    await expect(provider.destroyNodes(['d1'])).resolves.toMatchObject({
      type: 'nodeHasChildren',
      permanent: true,
    })
  })

  it('says nothing when the server took them', async () => {
    const { provider } = serverAnswering({ 'FileNode/set': { destroyed: ['f1'] } })

    await expect(provider.destroyNodes(['f1'])).resolves.toBeNull()
  })
})

describe('reading a file', () => {
  it('downloads the blob the node carries, not the one an upload returned', async () => {
    // The server re-addresses the content on store: the upload's blob id does
    // not resolve afterwards.
    const { provider, fetchRaw } = serverAnswering({})

    await provider.readFile(node({ blobId: 'stored-blob' }))

    expect(fetchRaw.mock.calls[0]![0]).toBe(
      'https://example.test/download/acc/stored-blob/settings.json?accept=application%2Fjson',
    )
  })

  it('has nothing to download for a directory', async () => {
    const { provider, fetchRaw } = serverAnswering({})

    await expect(
      provider.readFile(node({ nodeType: 'directory', blobId: null })),
    ).resolves.toBeNull()
    expect(fetchRaw).not.toHaveBeenCalled()
  })
})
