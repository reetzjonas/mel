/*
 * Turning a stored contact field into something the OS can act on.
 *
 * Kept apart from the view so each rule can be stated once and tested: what a
 * phone number looks like on a card and what a `tel:` URI may contain are not
 * the same thing.
 */

/**
 * A `tel:` URI, or null for a value with no number in it at all.
 *
 * RFC 3966 tolerates visual separators, but dialers vary in what they make of
 * "(030) 12 34" — so the spaces, brackets and dashes that make a number
 * readable on the card are dropped here, and only a leading + survives, since
 * that one carries meaning.
 */
export function telHref(value: string): string | null {
  const trimmed = value.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return null
  return `tel:${trimmed.startsWith('+') ? '+' : ''}${digits}`
}

/**
 * A map search for a postal address, or null for an empty one.
 *
 * OpenStreetMap rather than a `geo:` URI: geo: wants coordinates, and every
 * desktop browser simply does nothing with it. Clicking hands the address to
 * osm.org, which is why it is a link the user chooses to follow rather than
 * anything the app fetches by itself.
 */
export function mapHref(address: string): string | null {
  // A stored address is multi-line; a search query is one line. Empty lines
  // are dropped rather than joined, or a blank address becomes a search for ",".
  const query = address
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ')
  if (!query) return null
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`
}
