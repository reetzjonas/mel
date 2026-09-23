import type { EmailBody, EmailBodyPart } from './email'

/**
 * Recognising OpenPGP mail and taking it apart, before any cryptography
 * (issue #63). Pure: the library that checks and decrypts is loaded only once
 * one of these says there is something to check.
 *
 * Four shapes reach a mailbox:
 * - PGP/MIME encrypted (RFC 3156 §4): `multipart/encrypted` holding a version
 *   part and the ciphertext. The server cannot read into it, so its textBody
 *   and htmlBody are empty and both halves come back as attachments.
 * - PGP/MIME signed (RFC 3156 §5): `multipart/signed`, the content and a
 *   detached signature over its exact bytes. The server shows the content as
 *   the body and the signature as an attachment.
 * - Inline encrypted or clearsigned: armor sitting in a text/plain body.
 */
export type PgpKind = 'mimeEncrypted' | 'mimeSigned' | 'inlineEncrypted' | 'inlineSigned'

const PGP_ENCRYPTED = 'application/pgp-encrypted'
const PGP_SIGNATURE = 'application/pgp-signature'

const MESSAGE_BEGIN = '-----BEGIN PGP MESSAGE-----'
const MESSAGE_END = '-----END PGP MESSAGE-----'
const SIGNED_BEGIN = '-----BEGIN PGP SIGNED MESSAGE-----'
const SIGNATURE_BEGIN = '-----BEGIN PGP SIGNATURE-----'
const SIGNATURE_END = '-----END PGP SIGNATURE-----'

const typeOf = (p: EmailBodyPart) => p.type.toLowerCase().split(';')[0]!.trim()

export function pgpKind(body: EmailBody): PgpKind | null {
  if (body.attachments.some((p) => typeOf(p) === PGP_ENCRYPTED)) return 'mimeEncrypted'
  if (body.attachments.some((p) => typeOf(p) === PGP_SIGNATURE)) return 'mimeSigned'
  /*
   * Inline armor is only looked for in a plain-text body. An HTML body with
   * armor in it has been through an editor that may have re-wrapped or
   * escaped it, and a block pulled out of markup is one the sender's words
   * around it can be made to look part of.
   */
  const text = body.html ? null : body.text
  if (text?.includes(MESSAGE_BEGIN)) return 'inlineEncrypted'
  if (text?.includes(SIGNED_BEGIN)) return 'inlineSigned'
  return null
}

/** The part of a PGP/MIME encrypted message holding the ciphertext. */
export function encryptedPart(body: EmailBody): EmailBodyPart | null {
  return body.attachments.find((p) => typeOf(p) !== PGP_ENCRYPTED && p.blobId) ?? null
}

/**
 * The parts that are the machinery rather than the message: the version part,
 * the ciphertext, the detached signature. Once the band says what they meant,
 * offering them as files as well only invites opening a signature in a text
 * editor.
 */
export function pgpMachinery(body: EmailBody, kind: PgpKind): Set<EmailBodyPart> {
  if (kind === 'mimeEncrypted') {
    const cipher = encryptedPart(body)
    return new Set(body.attachments.filter((p) => typeOf(p) === PGP_ENCRYPTED || p === cipher))
  }
  if (kind === 'mimeSigned') {
    return new Set(body.attachments.filter((p) => typeOf(p) === PGP_SIGNATURE))
  }
  return new Set()
}

/** Byte-for-byte string view, so string offsets are byte offsets. */
function binaryString(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return out
}

/** Every line ending as CRLF: the form a MIME signature is computed over. */
export function canonicalLines(bytes: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    if (b === 0x0a && bytes[i - 1] !== 0x0d) out.push(0x0d)
    out.push(b)
  }
  return Uint8Array.from(out)
}

/** The header block of an entity, unfolded, and where its body starts. */
function headerBlock(text: string, from = 0): { headers: string; bodyStart: number } {
  const crlf = text.indexOf('\r\n\r\n', from)
  const lf = text.indexOf('\n\n', from)
  const end = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf
  if (end === -1) return { headers: text.slice(from), bodyStart: text.length }
  const sep = end === crlf ? 4 : 2
  return {
    headers: text.slice(from, end).replace(/\r?\n[ \t]+/g, ' '),
    bodyStart: end + sep,
  }
}

function header(headers: string, name: string): string | null {
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im')
  return re.exec(headers)?.[1]?.trim() ?? null
}

function param(value: string, name: string): string | null {
  const re = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i')
  const m = re.exec(value)
  return m ? (m[1] ?? m[2] ?? null) : null
}

/**
 * A delimiter line: `--boundary` at the start of a line, followed only by
 * optional whitespace (or `--` for the closing one). Returns where the line
 * starts, including the line break before it, and where the next line begins.
 */
function findDelimiter(
  text: string,
  boundary: string,
  from: number,
): { lineStart: number; next: number } | null {
  const marker = `--${boundary}`
  let at = text.indexOf(marker, from)
  while (at !== -1) {
    const atLineStart = at === 0 || text[at - 1] === '\n'
    const rest = text.slice(at + marker.length, at + marker.length + 80)
    const tail = /^(--)?[ \t]*(\r?\n|$)/.exec(rest)
    if (atLineStart && tail) {
      // The line break before the delimiter belongs to the delimiter
      // (RFC 2046 §5.1.1), so it is not part of the content it closes.
      let lineStart = at
      if (text[lineStart - 1] === '\n') lineStart--
      if (text[lineStart - 1] === '\r') lineStart--
      return { lineStart, next: at + marker.length + tail[0].length }
    }
    at = text.indexOf(marker, at + 1)
  }
  return null
}

/**
 * The signed content and detached signature of a `multipart/signed` message,
 * taken from its raw bytes.
 *
 * Why the raw message and not the parts the server lists: RFC 3156 signs the
 * first body part exactly as transmitted, its own headers included. The
 * server hands out a blob per leaf part with the headers already stripped,
 * so no part it lists is the thing that was signed.
 *
 * Only a top-level `multipart/signed` is taken apart. One nested further in
 * (a signed part inside an unsigned `multipart/mixed`, say) would make only
 * part of what the reader sees signed, and saying "signed" over the whole of
 * it would be wrong.
 */
export function splitSigned(raw: Uint8Array): { signed: Uint8Array; signature: string } | null {
  const text = binaryString(raw)
  const { headers, bodyStart } = headerBlock(text)
  const type = header(headers, 'Content-Type')
  if (!type || !/^multipart\/signed\b/i.test(type)) return null
  if ((param(type, 'protocol') ?? '').toLowerCase() !== PGP_SIGNATURE) return null
  const boundary = param(type, 'boundary')
  if (!boundary) return null

  const first = findDelimiter(text, boundary, bodyStart)
  if (!first) return null
  const second = findDelimiter(text, boundary, first.next)
  if (!second) return null
  const third = findDelimiter(text, boundary, second.next)
  if (!third) return null

  const sigPart = text.slice(second.next, third.lineStart)
  const begin = sigPart.indexOf(SIGNATURE_BEGIN)
  const end = sigPart.indexOf(SIGNATURE_END)
  if (begin === -1 || end === -1) return null

  return {
    signed: canonicalLines(raw.subarray(first.next, second.lineStart)),
    signature: sigPart.slice(begin, end + SIGNATURE_END.length),
  }
}

/** Whether a MIME entity's own header says it is `multipart/signed`. */
export function isSignedEntity(raw: Uint8Array): boolean {
  const { headers } = headerBlock(binaryString(raw.subarray(0, 64 * 1024)))
  const type = header(headers, 'Content-Type')
  return Boolean(type && /^multipart\/signed\b/i.test(type))
}

export interface InlineBlock {
  before: string
  armor: string
  after: string
}

/**
 * The first armored block in a text body, and the text around it.
 *
 * What surrounds it matters: a clearsigned block quoted inside an unsigned
 * reply is a signature over the quote only, and the reader has to be told
 * that the rest was not covered.
 */
export function inlineBlock(
  text: string,
  kind: 'inlineEncrypted' | 'inlineSigned',
): InlineBlock | null {
  const [beginMark, endMark] =
    kind === 'inlineEncrypted' ? [MESSAGE_BEGIN, MESSAGE_END] : [SIGNED_BEGIN, SIGNATURE_END]
  const begin = text.indexOf(beginMark)
  if (begin === -1) return null
  const endAt = text.indexOf(endMark, begin)
  if (endAt === -1) return null
  const end = endAt + endMark.length
  return { before: text.slice(0, begin), armor: text.slice(begin, end), after: text.slice(end) }
}

/** What mel shows about a key: enough to recognise it and check it is the right one. */
export interface KeyInfo {
  /** Hex, lower case, as the library gives it. */
  fingerprint: string
  userIds: string[]
  /** ISO date. */
  created: string
  /** ISO date, or null for a key that does not expire. */
  expires: string | null
  revoked: boolean
  /** e.g. "ed25519", "rsa 4096". */
  algorithm: string
}

/**
 * The user's own key: its description plus the secret key exactly as it was
 * exported, still sealed by its own passphrase. mel never stores one that is
 * not (see docs/notes/pgp-smime.md).
 */
export interface OwnKey extends KeyInfo {
  armored: string
}

/** How a signature checked out. */
export type SignatureCheck =
  /** Made by a key that belongs to the sender, and the content is unchanged. */
  | { state: 'valid'; signer: string; fingerprint: string; own: boolean }
  /** Signed, but by no key mel holds for this sender: nothing can be said. */
  | { state: 'unknownKey'; keyId: string }
  /** A known key, and the content does not match what it signed. */
  | { state: 'invalid' }

/** Groups of four, the way fingerprints are read out and compared. */
export function formatFingerprint(hex: string): string {
  return (
    hex
      .toUpperCase()
      .match(/.{1,4}/g)
      ?.join(' ') ?? ''
  )
}
