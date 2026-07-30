import type { SearchCondition, SearchQuery } from '../domain/search'

/**
 * Fastmail-style search syntax → SearchQuery AST.
 * Supported: bare terms, "quoted phrases", from:/to:/subject:, is:unread,
 * is:flagged, has:attachment, before:/after: (YYYY-MM-DD), -negation, OR.
 * Terms are AND-ed; OR binds the two neighbouring terms.
 */
export function parseSearch(input: string): SearchQuery | null {
  const tokens = tokenize(input)
  if (!tokens.length) return null

  const nodes: SearchQuery[] = []
  const ors: number[] = []
  for (const tok of tokens) {
    if (tok === 'OR') {
      if (nodes.length) ors.push(nodes.length - 1)
      continue
    }
    const negated = tok.startsWith('-') && tok.length > 1
    const raw = negated ? tok.slice(1) : tok
    const cond = toCondition(raw)
    if (!cond) continue
    nodes.push(negated ? { op: 'NOT', children: [cond] } : cond)
  }
  if (!nodes.length) return null

  // Merge OR pairs (left OR right) into groups, right to left.
  for (const i of ors.reverse()) {
    if (i + 1 >= nodes.length) continue
    const [left, right] = [nodes[i]!, nodes[i + 1]!]
    nodes.splice(i, 2, { op: 'OR', children: [left, right] })
  }
  return nodes.length === 1 ? nodes[0]! : { op: 'AND', children: nodes }
}

function tokenize(input: string): string[] {
  const out: string[] = []
  const re = /(-?[a-z]+:"[^"]*")|(-?"[^"]*")|(\S+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(input))) out.push(m[0]!)
  return out
}

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

function toCondition(tok: string): SearchCondition | null {
  const colon = tok.indexOf(':')
  if (colon > 0) {
    const key = tok.slice(0, colon).toLowerCase()
    const value = unquote(tok.slice(colon + 1))
    switch (key) {
      case 'from':
        return value ? { from: value } : null
      case 'to':
        return value ? { to: value } : null
      case 'subject':
        return value ? { subject: value } : null
      case 'is':
        if (value === 'unread') return { isUnread: true }
        if (value === 'read') return { isUnread: false }
        if (value === 'flagged' || value === 'starred') return { isFlagged: true }
        return null
      case 'has':
        return value === 'attachment' ? { hasAttachment: true } : null
      case 'before':
        return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { before: value } : null
      case 'after':
        return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { after: value } : null
      default:
        return { text: unquote(tok) }
    }
  }
  const text = unquote(tok)
  return text ? { text } : null
}
