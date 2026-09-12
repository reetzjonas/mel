import { afterEach, describe, expect, it, vi } from 'vitest'
// Vite hands the module over as text; node:fs would need Node types this
// DOM project deliberately does not pull into src.
import i18nSource from './i18n.ts?raw'

/** Load i18n afresh: the locale is resolved once, at module load. */
async function loadWith(language: string, stored?: string) {
  vi.resetModules()
  localStorage.clear()
  if (stored) localStorage.setItem('mel:lang', stored)
  vi.stubGlobal('navigator', { ...navigator, language })
  return import('./i18n')
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('picking a language', () => {
  it('follows the browser', async () => {
    expect((await loadWith('de-DE')).currentLocale).toBe('de')
    expect((await loadWith('en-GB')).currentLocale).toBe('en')
  })

  it('matches on the language, not on the region', async () => {
    // de-AT and de-CH are the same strings as far as this app is concerned.
    expect((await loadWith('de-AT')).currentLocale).toBe('de')
  })

  it('falls back to English for a language nothing is translated into', async () => {
    // Rendering nothing at all would be the alternative.
    expect((await loadWith('fr-FR')).currentLocale).toBe('en')
    expect((await loadWith('')).currentLocale).toBe('en')
  })

  it('lets a stored choice override the browser', async () => {
    expect((await loadWith('en-GB', 'de')).currentLocale).toBe('de')
    expect((await loadWith('de-DE', 'en')).currentLocale).toBe('en')
  })
})

describe('looking a string up', () => {
  it('answers in the chosen language', async () => {
    const { t } = await loadWith('de-DE')
    expect(t('mail.reply')).toBe('Antworten')
  })

  it('uses English directly when that is the language', async () => {
    const { t } = await loadWith('en-GB')
    expect(t('mail.reply')).toBe('Reply')
  })
})

/*
 * Read off the source rather than the module, because neither table is
 * exported — and exporting them to be testable would add a seam the app
 * never uses. The invariant is worth the unusual approach: the German table
 * is typed as a *partial* record, so a key misspelled there is accepted by
 * the compiler, never looked up, and leaves the string quietly in English
 * while the table claims otherwise.
 */
function keysOf(block: string): string[] {
  return [...block.matchAll(/^ {2}'([^']+)':/gm)].map((m) => m[1]!)
}

describe('the translation tables themselves', () => {
  it('has no German entry for a key that does not exist', () => {
    const source = i18nSource
    const germanAt = source.indexOf('const de: Partial<Record<MsgKey, string>>')
    expect(germanAt).toBeGreaterThan(0)

    const english = new Set(keysOf(source.slice(0, germanAt)))
    const orphans = keysOf(source.slice(germanAt)).filter((k) => !english.has(k))

    expect(orphans).toEqual([])
  })

  it('translates the strings a German speaker meets first', async () => {
    // Not every string has to be translated, but the ones on the way in do.
    const { t } = await loadWith('de-DE')
    for (const [key, english] of [
      ['login.connect', 'Connect'],
      ['mail.archive', 'Archive'],
      ['compose.send', 'Send'],
    ] as const) {
      expect(t(key), `${key} is still English`).not.toBe(english)
    }
  })
})
