import { describe, expect, it } from 'vitest'
import { toFileNode } from './files'

describe('toFileNode', () => {
  it('keeps a file with everything the server set', () => {
    expect(
      toFileNode({
        id: 'f1',
        parentId: 'd1',
        nodeType: 'file',
        name: 'notes.txt',
        blobId: 'b1',
        type: 'text/plain',
        size: 12,
        created: '2026-01-01T00:00:00Z',
        modified: '2026-02-02T00:00:00Z',
      }),
    ).toEqual({
      id: 'f1',
      parentId: 'd1',
      nodeType: 'file',
      name: 'notes.txt',
      blobId: 'b1',
      type: 'text/plain',
      size: 12,
      created: '2026-01-01T00:00:00Z',
      modified: '2026-02-02T00:00:00Z',
    })
  })

  it('reads a directory as having no content', () => {
    const dir = toFileNode({ id: 'd1', nodeType: 'directory', name: 'notes' })

    expect(dir).toMatchObject({ nodeType: 'directory', blobId: null, type: null, size: null })
    expect(dir.parentId).toBeNull()
  })

  it('falls back to created when the client that wrote the node left modified unset', () => {
    expect(toFileNode({ id: 'f1', created: '2026-01-01T00:00:00Z' }).modified).toBe(
      '2026-01-01T00:00:00Z',
    )
  })

  it('keeps a node whose type it does not recognise', () => {
    // The node type list is open to registration; dropping the row would be
    // worse than showing it with the wrong icon.
    expect(toFileNode({ id: 'f1', nodeType: 'quantum' }).nodeType).toBe('file')
  })

  it('reads a symlink as its own type', () => {
    expect(toFileNode({ id: 'f1', nodeType: 'symlink' }).nodeType).toBe('symlink')
  })
})
