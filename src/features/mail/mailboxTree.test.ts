import { describe, expect, it } from 'vitest'
import type { Mailbox } from '../../domain/mailbox'
import { descendantsOf, mailboxTree } from './mailboxTree'

const mb = (id: string, name: string, parentId: string | null, role: string | null = null) =>
  ({ id, name, parentId, role, sortOrder: 0, totalEmails: 0 }) as Mailbox

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
