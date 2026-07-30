// Provider-agnostic search query AST. The parser (lib/searchParser.ts) builds
// this from Fastmail-style syntax; each provider maps it to its own filter.

export interface SearchCondition {
  text?: string
  from?: string
  to?: string
  subject?: string
  hasAttachment?: boolean
  isUnread?: boolean
  isFlagged?: boolean
  /** ISO dates (YYYY-MM-DD). */
  before?: string
  after?: string
}

export interface SearchGroup {
  op: 'AND' | 'OR' | 'NOT'
  children: SearchQuery[]
}

export type SearchQuery = SearchCondition | SearchGroup

export function isGroup(q: SearchQuery): q is SearchGroup {
  return 'op' in q && Array.isArray((q as SearchGroup).children)
}
