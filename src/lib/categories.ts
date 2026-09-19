/**
 * Event categories as the text box shows them: comma separated, in the order
 * they were typed. A category is a free-form tag ("Work", "Birthday party"), so
 * spaces inside one are kept and only the commas separate.
 */

/** The categories a text box holds — trimmed, without blanks or repeats. */
export function parseCategories(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(',')) {
    const name = part.trim()
    // Compared case-insensitively so "Work, work" is one tag, but the first
    // spelling is the one kept.
    const key = name.toLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

export function formatCategories(categories: string[] | undefined): string {
  return (categories ?? []).join(', ')
}
