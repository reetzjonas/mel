import { describe, expect, it } from 'vitest'
import { isGroup, type SearchGroup } from '../domain/search'
import { parseSearch } from './searchParser'

describe('parseSearch', () => {
  it('returns null for empty input', () => {
    expect(parseSearch('')).toBeNull()
    expect(parseSearch('   ')).toBeNull()
  })

  it('parses bare terms as AND', () => {
    expect(parseSearch('hello world')).toEqual({
      op: 'AND',
      children: [{ text: 'hello' }, { text: 'world' }],
    })
  })

  it('parses field prefixes', () => {
    expect(parseSearch('from:alice@x.de subject:Report')).toEqual({
      op: 'AND',
      children: [{ from: 'alice@x.de' }, { subject: 'Report' }],
    })
  })

  it('parses quoted phrases including in fields', () => {
    expect(parseSearch('subject:"quarterly report"')).toEqual({ subject: 'quarterly report' })
    expect(parseSearch('"exact phrase"')).toEqual({ text: 'exact phrase' })
  })

  it('parses is:/has:/date filters', () => {
    expect(parseSearch('is:unread has:attachment before:2026-01-01 after:2025-06-15')).toEqual({
      op: 'AND',
      children: [
        { isUnread: true },
        { hasAttachment: true },
        { before: '2026-01-01' },
        { after: '2025-06-15' },
      ],
    })
    expect(parseSearch('is:flagged')).toEqual({ isFlagged: true })
    expect(parseSearch('is:read')).toEqual({ isUnread: false })
  })

  it('parses negation', () => {
    expect(parseSearch('-from:spam@x.com report')).toEqual({
      op: 'AND',
      children: [{ op: 'NOT', children: [{ from: 'spam@x.com' }] }, { text: 'report' }],
    })
  })

  it('parses OR between neighbours', () => {
    expect(parseSearch('from:a OR from:b')).toEqual({
      op: 'OR',
      children: [{ from: 'a' }, { from: 'b' }],
    })
    expect(parseSearch('urgent from:a OR from:b')).toEqual({
      op: 'AND',
      children: [{ text: 'urgent' }, { op: 'OR', children: [{ from: 'a' }, { from: 'b' }] }],
    })
  })

  it('ignores malformed dates and empty fields', () => {
    expect(parseSearch('before:tomorrow')).toBeNull()
    expect(parseSearch('from:')).toBeNull()
  })
})

/*
 * Everything that walks a parsed query — the JMAP translation above all —
 * branches on this. Asserted against real parser output rather than
 * hand-built literals, so it keeps answering for the shapes actually produced.
 */
describe('isGroup', () => {
  it('tells a combining node from a single condition', () => {
    const query = parseSearch('urgent from:a OR from:b')
    expect(query).not.toBeNull()
    expect(isGroup(query!)).toBe(true)
    const children = (query as SearchGroup).children
    expect(isGroup(children[0]!)).toBe(false)
    expect(isGroup(children[1]!)).toBe(true)
  })

  it('does not mistake a lone condition for a group', () => {
    expect(isGroup(parseSearch('from:a')!)).toBe(false)
  })
})
