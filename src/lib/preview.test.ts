import { describe, expect, it } from 'vitest'
import { cleanPreview } from './preview'

describe('cleanPreview', () => {
  it('drops a style block the preview was truncated inside', () => {
    // Verbatim from a Discord notification mail.
    expect(
      cleanPreview('html, body, * { -webkit-text-size-adjust: none; text-size-adjust: non'),
    ).toBe('')
  })

  it('keeps the message text that follows a stylesheet', () => {
    expect(cleanPreview('a { color: red; } Du hast neue Nachrichten')).toBe(
      'Du hast neue Nachrichten',
    )
  })

  it('handles nested at-rules', () => {
    expect(cleanPreview('@media screen { .x { color: red } } Hallo Welt')).toBe('Hallo Welt')
  })

  it('leaves prose with braces alone', () => {
    expect(cleanPreview('Hi {name}, welcome aboard')).toBe('Hi {name}, welcome aboard')
  })

  it('strips HTML comments and collapses whitespace', () => {
    expect(cleanPreview('<!-- hidden -->  Hallo\n\n  Welt ')).toBe('Hallo Welt')
  })

  it('passes ordinary previews through unchanged', () => {
    expect(cleanPreview('Kurzes Update: Phase 0 laeuft.')).toBe('Kurzes Update: Phase 0 laeuft.')
  })
})
