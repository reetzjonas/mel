/**
 * Autocrypt headers (Level 1, https://autocrypt.org/level1.html), issue #101:
 * the sender's public key carried in every message, so correspondents can
 * pick it up without a keyserver.
 *
 * Pure: the server hands over the header values, this decides whether one of
 * them is a key for the sender, and writes the header mel sends.
 */

export interface AutocryptHeader {
  addr: string
  /** The sender asked for encryption whenever both sides can (`mutual`). */
  mutual: boolean
  /** The key as base64 of its binary form, whitespace removed. */
  keydata: string
}

const norm = (email: string) => email.trim().toLowerCase()

function parseOne(value: string): AutocryptHeader | null {
  const attrs = new Map<string, string>()
  for (const part of value.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      if (part.trim()) return null
      continue
    }
    const name = part.slice(0, eq).trim().toLowerCase()
    // A leading underscore marks an attribute a reader may ignore; any other
    // name it does not know makes the whole header one it must ignore (§2.1).
    if (name.startsWith('_')) continue
    if (!['addr', 'prefer-encrypt', 'keydata'].includes(name) || attrs.has(name)) return null
    attrs.set(name, part.slice(eq + 1).trim())
  }
  const addr = attrs.get('addr')
  const keydata = attrs.get('keydata')?.replace(/\s+/g, '')
  if (!addr || !keydata || !/^[A-Za-z0-9+/]+=*$/.test(keydata)) return null
  return { addr: norm(addr), mutual: attrs.get('prefer-encrypt') === 'mutual', keydata }
}

/**
 * The sender's Autocrypt key, or null.
 *
 * Only a header whose `addr` is the From address counts — anyone can write
 * any header, and a key for another address is a key for someone else. More
 * than one valid header for the address is treated as none, as the spec
 * asks: there is no telling which one the sender meant.
 */
export function parseAutocrypt(
  values: string[] | null | undefined,
  from: string,
): AutocryptHeader | null {
  const sender = norm(from)
  if (!sender) return null
  const valid = (values ?? [])
    .map(parseOne)
    .filter((h): h is AutocryptHeader => h !== null && h.addr === sender)
  return valid.length === 1 ? valid[0]! : null
}

/**
 * The header value mel sends, starting with the space after the colon.
 *
 * The key is cut into pieces of 76 separated by `sep`, which is where the
 * header may be folded. Whitespace inside `keydata` is ignored by readers, so
 * a fold there changes nothing.
 */
export function autocryptValue(addr: string, keydata: string, sep: string): string {
  const pieces = keydata.match(/.{1,76}/g) ?? []
  return ` addr=${addr}; keydata=${sep}${pieces.join(sep)}`
}
