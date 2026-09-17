import { describe, expect, it } from 'vitest'
import type { FileNode } from '../../domain/file'
import { symlinkPath } from './symlink'

const link = (target: string[] | null): FileNode => ({
  id: 's1',
  parentId: null,
  nodeType: 'symlink',
  name: 'shortcut',
  blobId: null,
  type: null,
  size: null,
  target,
  executable: false,
  created: '2026-01-01T00:00:00Z',
  modified: '2026-01-01T00:00:00Z',
})

describe('symlinkPath', () => {
  it('joins the path elements the way a reader expects', () => {
    expect(symlinkPath(link(['notes', 'today.txt']))).toBe('notes/today.txt')
  })

  it('spells an absolute target with its leading slash', () => {
    // The draft marks absolute with an empty first element, which joins to
    // exactly that slash.
    expect(symlinkPath(link(['', 'shared', 'plan.md']))).toBe('/shared/plan.md')
    expect(symlinkPath(link(['']))).toBe('/')
  })

  it('keeps a step up as it stands', () => {
    expect(symlinkPath(link(['..', 'archive']))).toBe('../archive')
  })

  it('says nothing rather than lying when there is no target', () => {
    expect(symlinkPath(link(null))).toBe('—')
    expect(symlinkPath(link([]))).toBe('—')
  })
})
