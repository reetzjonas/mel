import { describe, expect, it } from 'vitest'
import type { Mailbox } from '../../domain/mailbox'
import { descendantsOf, mailboxTree, moveTargets } from './mailboxTree'

const mb = (id: string, name: string, parentId: string | null, role: string | null = null) =>
  ({ id, name, parentId, role, sortOrder: 0, totalEmails: 0, mayCreateChild: true }) as Mailbox

const shape = (list: Mailbox[]) =>
  mailboxTree(list).map((n) => `${'  '.repeat(n.depth)}${n.mailbox.name}`)

describe('mailboxTree', () => {
  it('places every folder under its own parent instead of sorting globally', () => {
    // Alphabetically "Alpha" and "Zeta" would straddle "Scheduled", which is
    // what made a parent look childless in the flat list.
    const list = [
      mb('s', 'Scheduled', null),
      mb('a', 'Alpha', 's'),
      mb('z', 'Zeta', null),
      mb('i', 'Inbox', null, 'inbox'),
    ]
    expect(shape(list)).toEqual(['Inbox', 'Scheduled', '  Alpha', 'Zeta'])
  })

  it('indents by real depth, not just "has a parent"', () => {
    const list = [mb('a', 'A', null), mb('b', 'B', 'a'), mb('c', 'C', 'b')]
    expect(shape(list)).toEqual(['A', '  B', '    C'])
  })

  it('keeps roles first among siblings and sorts the rest by name', () => {
    const list = [
      mb('x', 'Zulu', null),
      mb('t', 'Trash', null, 'trash'),
      mb('i', 'Inbox', null, 'inbox'),
      mb('a', 'Alpha', null),
    ]
    expect(shape(list)).toEqual(['Inbox', 'Trash', 'Alpha', 'Zulu'])
  })

  it('still shows a folder whose parent is missing from the list', () => {
    // A partial mirror must not make folders disappear entirely.
    expect(shape([mb('orphan', 'Orphan', 'gone')])).toEqual(['Orphan'])
  })
})

describe('descendantsOf', () => {
  it('returns the whole subtree, parents before their children', () => {
    const list = [mb('a', 'A', null), mb('b', 'B', 'a'), mb('c', 'C', 'b'), mb('d', 'D', 'a')]
    expect(descendantsOf(list, 'a').map((m) => m.name)).toEqual(['B', 'C', 'D'])
    // Reversed, this is a safe deletion order: no parent before its children.
    expect(descendantsOf(list, 'a').reverse().map((m) => m.name)).toEqual(['D', 'C', 'B'])
  })

  it('is empty for a leaf', () => {
    expect(descendantsOf([mb('a', 'A', null)], 'a')).toEqual([])
  })
})

describe('moveTargets', () => {
  const tree = () => [
    mb('a', 'A', null),
    mb('b', 'B', 'a'),
    mb('c', 'C', 'b'),
    mb('d', 'D', null),
    mb('i', 'Inbox', null, 'inbox'),
  ]

  it('never offers a folder its own descendants', () => {
    // Moving A under B or C would detach that subtree from the tree entirely.
    expect(moveTargets(tree(), tree()[0]!).map((m) => m.name)).toEqual(['D'])
  })

  it('never offers the folder itself', () => {
    expect(moveTargets(tree(), tree()[3]!).map((m) => m.id)).not.toContain('d')
  })

  it('omits the current parent, which would change nothing', () => {
    // C sits under B already.
    expect(moveTargets(tree(), tree()[2]!).map((m) => m.name)).toEqual(['A', 'D'])
  })

  it('never offers a role folder as a parent', () => {
    // Inbox, Trash and the rest mean something to the server and other clients.
    expect(moveTargets(tree(), tree()[3]!).map((m) => m.role)).not.toContain('inbox')
  })

  it('can be empty when there is nowhere left to go', () => {
    expect(moveTargets([mb('only', 'Only', null)], mb('only', 'Only', null))).toEqual([])
  })
})
