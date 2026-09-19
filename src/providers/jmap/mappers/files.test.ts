import { describe, expect, it } from 'vitest'
import { toFileNode } from './files'

describe('toFileNode', () => {
  it('keeps a file with everything the server set', () => {
    expect(
      toFileNode({
        id: 'f1',
        parentId: 'd1',
        role: null,
        nodeType: 'file',
        name: 'notes.txt',
        blobId: 'b1',
        type: 'text/plain',
        size: 12,
        executable: true,
        created: '2026-01-01T00:00:00Z',
        modified: '2026-02-02T00:00:00Z',
      }),
    ).toEqual({
      id: 'f1',
      parentId: 'd1',
      role: null,
      nodeType: 'file',
      name: 'notes.txt',
      blobId: 'b1',
      type: 'text/plain',
      size: 12,
      target: null,
      executable: true,
      created: '2026-01-01T00:00:00Z',
      modified: '2026-02-02T00:00:00Z',
    })
  })

  it('reads a node with no executable bit as not executable', () => {
    // A server that leaves the property out is not saying "run me"; the domain
    // object is a plain boolean so nothing downstream has to handle three
    // states for a permission flag.
    expect(toFileNode({ id: 'f1' }).executable).toBe(false)
  })

  it('reads a directory as having no content', () => {
    const dir = toFileNode({ id: 'd1', nodeType: 'directory', name: 'notes' })

    expect(dir).toMatchObject({ nodeType: 'directory', blobId: null, type: null, size: null })
    expect(dir.parentId).toBeNull()
  })

  it('keeps a recognized top-level folder role', () => {
    expect(toFileNode({ id: 'trash', nodeType: 'directory', role: 'trash' }).role).toBe('trash')
    expect(toFileNode({ id: 'future', role: 'future' }).role).toBeNull()
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

  it('reads a symlink as its own type, with the path it points at', () => {
    const link = toFileNode({ id: 'f1', nodeType: 'symlink', target: ['notes', 'today.txt'] })

    expect(link.nodeType).toBe('symlink')
    expect(link.target).toEqual(['notes', 'today.txt'])
  })

  it('refuses a target that is not a path', () => {
    // The draft says a symlink's target must be non-null and everything else's
    // must be null; a server that gets it wrong should leave a link pointing
    // nowhere rather than something unprintable on the row.
    expect(toFileNode({ id: 'f1', nodeType: 'symlink', target: [1, 2] as never }).target).toBeNull()
    expect(toFileNode({ id: 'f1', nodeType: 'file' }).target).toBeNull()
  })
})
