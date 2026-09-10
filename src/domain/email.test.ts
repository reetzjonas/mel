import { describe, expect, it } from 'vitest'
import { matchesFilter, type EmailHeader } from './email'

const header = (keywords: Record<string, true>) => ({ keywords }) as EmailHeader

describe('matchesFilter', () => {
  it('keeps everything when no filter is active', () => {
    expect(matchesFilter(header({}), undefined)).toBe(true)
    expect(matchesFilter(header({ $seen: true, $flagged: true }), undefined)).toBe(true)
  })

  // Unread is the *absence* of $seen, not a keyword of its own — the one place
  // this predicate is easy to get backwards.
  it('treats a missing $seen as unread', () => {
    expect(matchesFilter(header({}), 'unread')).toBe(true)
    expect(matchesFilter(header({ $flagged: true }), 'unread')).toBe(true)
    expect(matchesFilter(header({ $seen: true }), 'unread')).toBe(false)
  })

  it('matches flagged on the keyword being present', () => {
    expect(matchesFilter(header({ $flagged: true }), 'flagged')).toBe(true)
    expect(matchesFilter(header({ $seen: true, $flagged: true }), 'flagged')).toBe(true)
    expect(matchesFilter(header({}), 'flagged')).toBe(false)
  })
})
