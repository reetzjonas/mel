import { describe, expect, it } from 'vitest'
import type { FileNode } from '../../domain/file'
import { deepestFirst, moveTargets, withDescendants } from './tree'

const dir = (id: string, parentId: string | null = null): FileNode => ({
  id,
  parentId,
  nodeType: 'directory',
  name: id,
  blobId: null,
  type: null,
  size: null,
  executable: false,
  created: '2026-01-01T00:00:00Z',
  modified: '2026-01-01T00:00:00Z',
})

const file = (id: string, parentId: string | null): FileNode => ({
  ...dir(id, parentId),
  nodeType: 'file',
})

describe('withDescendants', () => {
  it('collects everything beneath a folder', () => {
    const all = [dir('a'), dir('b', 'a'), file('c', 'b'), dir('other')]

    expect([...withDescendants(all, ['a'])].sort()).toEqual(['a', 'b', 'c'])
  })

  it('leaves a sibling subtree alone', () => {
    const all = [dir('a'), file('under-a', 'a'), dir('b'), file('under-b', 'b')]

    expect(withDescendants(all, ['a']).has('under-b')).toBe(false)
  })

  it('survives a parent chain that points at itself', () => {
    // Never seen from a server, but a cycle here would hang the walk.
    const all = [dir('loop', 'loop')]

    expect([...withDescendants(all, ['loop'])]).toEqual(['loop'])
  })
})

describe('deepestFirst', () => {
  it('groups by depth with the leaves first', () => {
    // The server refuses a node and its parent in one call, so each level has
    // to go on its own — deepest first.
    const all = [dir('a'), dir('b', 'a'), file('c', 'b')]

    expect(deepestFirst(all, new Set(['a', 'b', 'c']))).toEqual([['c'], ['b'], ['a']])
  })

  it('takes siblings at one depth together', () => {
    const all = [dir('a'), file('x', 'a'), file('y', 'a')]

    const levels = deepestFirst(all, new Set(['x', 'y']))

    expect(levels).toHaveLength(1)
    expect(levels[0]!.sort()).toEqual(['x', 'y'])
  })
})

describe('moveTargets', () => {
  it('offers the other folders', () => {
    const all = [dir('a'), dir('b'), dir('c')]

    expect(moveTargets(all, ['a'], null).map((n) => n.id)).toEqual(['b', 'c'])
  })

  it('refuses a folder moving into itself or anything under it', () => {
    // The server would be left holding a cycle with no path to the root.
    const all = [dir('a'), dir('inside', 'a'), dir('deeper', 'inside'), dir('elsewhere')]

    expect(moveTargets(all, ['a'], null).map((n) => n.id)).toEqual(['elsewhere'])
  })

  it('leaves out the folder the nodes are already in', () => {
    const all = [dir('here'), dir('there')]

    expect(moveTargets(all, ['some-file'], 'here').map((n) => n.id)).toEqual(['there'])
  })

  it('never offers a file as a destination', () => {
    const all = [dir('folder'), file('doc.txt', null)]

    expect(moveTargets(all, [], null).map((n) => n.id)).toEqual(['folder'])
  })
})
