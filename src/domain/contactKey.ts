/**
 * A public key on a contact card: JSContact `cryptoKeys` (RFC 9553 §2.6.3),
 * which is where a PGP public key or an S/MIME certificate belongs.
 *
 * Only the public half ever lives here. A card is server-side data that syncs
 * to every device and is shared as easily as any other contact detail — a
 * private key has no business in one. The user's own private key is a separate
 * problem with a separate home (issue #63, part 2).
 *
 * mel stores the key the way the card carries it and understands two text
 * forms: PGP's ASCII armor and PEM. Anything else — a DER certificate, say —
 * still round-trips untouched, it just cannot be named or offered as a
 * download under the right extension.
 */

export interface ContactKey {
  /**
   * The key itself as a `data:` URI, or a URL to fetch it from.
   *
   * Cards in the wild carry both: mel writes `data:` (the key travels with the
   * card, like the photo does), and reads whatever is there.
   */
  uri: string
  /** `application/pgp-keys`, `application/pkix-cert`, … or '' if unstated. */
  mediaType: string
}

export type KeyKind = 'pgp' | 'smime' | 'unknown'

const PGP_ARMOR = '-----BEGIN PGP PUBLIC KEY BLOCK-----'
const PEM_CERT = '-----BEGIN CERTIFICATE-----'

export const PGP_MEDIA_TYPE = 'application/pgp-keys'
export const SMIME_MEDIA_TYPE = 'application/pkix-cert'

/**
 * What kind of key this is.
 *
 * The declared media type is only consulted when the key itself cannot be
 * read: it is optional in JSContact, and a card that names one has usually
 * been through some other client's idea of the right value.
 */
export function keyKind(key: ContactKey): KeyKind {
  const text = keyText(key)
  if (text?.includes(PGP_ARMOR)) return 'pgp'
  if (text?.includes(PEM_CERT)) return 'smime'
  const type = key.mediaType.toLowerCase()
  if (type.includes('pgp')) return 'pgp'
  if (type.includes('pkix') || type.includes('pkcs7') || type.includes('x-x509')) return 'smime'
  return 'unknown'
}

/** The raw bytes behind a `data:` URI, or null for one pointing elsewhere. */
export function keyBytes(uri: string): Uint8Array | null {
  const comma = uri.indexOf(',')
  if (!uri.startsWith('data:') || comma === -1) return null
  const meta = uri.slice(5, comma)
  const payload = uri.slice(comma + 1)
  try {
    if (meta.endsWith(';base64')) {
      const binary = atob(payload)
      return Uint8Array.from(binary, (c) => c.charCodeAt(0))
    }
    return new TextEncoder().encode(decodeURIComponent(payload))
  } catch {
    // A truncated or mis-encoded URI is data mel did not write; it stays on
    // the card, it simply cannot be shown as anything but a link.
    return null
  }
}

/** The key as text, when it is a `data:` URI holding a text form. */
export function keyText(key: ContactKey): string | null {
  const bytes = keyBytes(key.uri)
  if (!bytes) return null
  const text = new TextDecoder().decode(bytes)
  // A DER certificate decodes to mojibake rather than throwing, so the answer
  // is "is this one of the armored forms", not "did decoding work".
  return text.includes(PGP_ARMOR) || text.includes(PEM_CERT) ? text : null
}

/** How big the key is, for a list that would otherwise show only its kind. */
export function keySize(key: ContactKey): number {
  return keyBytes(key.uri)?.byteLength ?? 0
}

/**
 * A pasted or dropped key, or null when the text is not one.
 *
 * Deliberately strict: the whole point of storing a key is that it is the
 * right one, and "we kept whatever you gave us" is not a service. Trailing
 * text around the armor is allowed — people paste a block out of an email
 * together with the line above it.
 */
export function keyFromText(text: string): ContactKey | null {
  const pgp = block(text, PGP_ARMOR, '-----END PGP PUBLIC KEY BLOCK-----')
  if (pgp) return dataUri(pgp, PGP_MEDIA_TYPE)
  const pem = block(text, PEM_CERT, '-----END CERTIFICATE-----')
  if (pem) return dataUri(pem, SMIME_MEDIA_TYPE)
  return null
}

function block(text: string, begin: string, end: string): string | null {
  const from = text.indexOf(begin)
  const to = text.indexOf(end)
  if (from === -1 || to === -1 || to < from) return null
  return text.slice(from, to + end.length) + '\n'
}

function dataUri(text: string, mediaType: string): ContactKey {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return { uri: `data:${mediaType};base64,${btoa(binary)}`, mediaType }
}

/** The file name a downloaded key should get, by kind. */
export function keyFileName(key: ContactKey, contactName: string): string {
  const stem =
    contactName
      .trim()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '') || 'contact'
  const kind = keyKind(key)
  return `${stem}${kind === 'pgp' ? '.asc' : kind === 'smime' ? '.pem' : '.key'}`
}
