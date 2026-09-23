import type { EmailAddress } from '../domain/email'

/**
 * Writing a MIME message by hand, for the one kind the server cannot build
 * for us: OpenPGP mail (issue #63).
 *
 * Everything else goes out as a JMAP Email object that the server turns into
 * MIME. A signed message cannot: the signature covers the exact bytes of its
 * first part, and a server that writes that part itself writes different
 * bytes. An encrypted one cannot either, since the server must not see what
 * is inside. So mel writes the whole message and imports it.
 *
 * Deliberately narrow: every part is base64, so the output is 7-bit clean
 * (RFC 3156 requires that of signed content) and nothing depends on
 * line-length or trailing-whitespace rules. Lines end in CRLF throughout,
 * which is the canonical form the signature is computed over. An entity
 * never ends in a line break; whoever places it adds the one that belongs to
 * the next delimiter.
 */

export interface MimeAttachment {
  name: string
  type: string
  data: Uint8Array
  /** Set for a picture drawn inside the HTML: goes out inline with this Content-ID. */
  cid?: string | null
}

const CRLF = '\r\n'

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Base64 in lines of 76, as RFC 2045 asks. */
function base64Lines(bytes: Uint8Array): string {
  return (base64(bytes).match(/.{1,76}/g) ?? ['']).join(CRLF)
}

const utf8 = (s: string) => new TextEncoder().encode(s)
const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s)

export function boundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `mel-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * RFC 2047 encoded words for a header value that is not plain ASCII. Split
 * on character boundaries so no word cuts a UTF-8 sequence in half, and kept
 * short enough that a folded line stays under 78 characters.
 */
export function encodeWords(value: string): string {
  if (isAscii(value)) return value
  const words: string[] = []
  let chunk = ''
  for (const ch of value) {
    if (utf8(chunk + ch).length > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${base64(utf8(w))}?=`).join(`${CRLF} `)
}

/** An address as a header writes it: `Name <a@b>`, quoted or encoded as needed. */
export function formatAddress(a: EmailAddress): string {
  const name = a.name?.trim()
  if (!name) return a.email
  if (!isAscii(name)) return `${encodeWords(name)} <${a.email}>`
  // atext plus spaces needs no quotes; anything else (a comma, a dot) does.
  if (/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(name)) return `${name} <${a.email}>`
  return `"${name.replace(/[\\"]/g, '\\$&')}" <${a.email}>`
}

/** A file name parameter, RFC 2231-encoded when it is not plain ASCII. */
function fileParam(param: string, name: string): string {
  if (isAscii(name) && !/["\\]/.test(name)) return `${param}="${name}"`
  const encoded = Array.from(utf8(name), (b) =>
    /[A-Za-z0-9._-]/.test(String.fromCharCode(b))
      ? String.fromCharCode(b)
      : `%${b.toString(16).toUpperCase().padStart(2, '0')}`,
  ).join('')
  return `${param}*=UTF-8''${encoded}`
}

function leaf(headers: string[], data: Uint8Array): string {
  return [...headers, 'Content-Transfer-Encoding: base64', '', base64Lines(data)].join(CRLF)
}

/** A multipart entity around parts that are entities themselves. */
export function multipart(type: string, parts: string[], params = ''): string {
  const b = boundary()
  return [
    `Content-Type: ${type}; boundary="${b}"${params}`,
    '',
    ...parts.map((p) => `--${b}${CRLF}${p}`),
    `--${b}--`,
  ].join(CRLF)
}

function textPart(subtype: 'plain' | 'html', text: string): string {
  return leaf([`Content-Type: text/${subtype}; charset=utf-8`], utf8(text))
}

function attachmentPart(a: MimeAttachment, inline: boolean): string {
  const type = a.type || 'application/octet-stream'
  const headers = [`Content-Type: ${type}; ${fileParam('name', a.name)}`]
  if (inline && a.cid) {
    headers.push(`Content-Disposition: inline; ${fileParam('filename', a.name)}`)
    headers.push(`Content-ID: <${a.cid}>`)
  } else {
    headers.push(`Content-Disposition: attachment; ${fileParam('filename', a.name)}`)
  }
  return leaf(headers, a.data)
}

/**
 * The body of a message as one entity: the text, the HTML with its inline
 * pictures, and the files, nested the way every client expects
 * (mixed › alternative › related).
 */
export function bodyEntity(content: {
  text: string
  html: string | null
  attachments: MimeAttachment[]
}): string {
  const inline = content.html ? content.attachments.filter((a) => a.cid) : []
  const files = content.attachments.filter((a) => !inline.includes(a))
  let body = textPart('plain', content.text)
  if (content.html) {
    const html = textPart('html', content.html)
    const rich = inline.length
      ? multipart('multipart/related', [html, ...inline.map((a) => attachmentPart(a, true))])
      : html
    body = multipart('multipart/alternative', [body, rich])
  }
  return files.length
    ? multipart('multipart/mixed', [body, ...files.map((a) => attachmentPart(a, false))])
    : body
}

/** RFC 3156 §5: the entity as signed, and its detached signature. */
export function signedEntity(entity: string, signature: string, micalg: string): string {
  const sig = [
    'Content-Type: application/pgp-signature; name="signature.asc"',
    'Content-Description: OpenPGP digital signature',
    'Content-Disposition: attachment; filename="signature.asc"',
    '',
    signature.trim().replace(/\r?\n/g, CRLF),
  ].join(CRLF)
  return multipart(
    'multipart/signed',
    [entity, sig],
    `; micalg=${micalg}; protocol="application/pgp-signature"`,
  )
}

/** RFC 3156 §4: the version part and the armored ciphertext. */
export function encryptedEntity(armored: string): string {
  const version = [
    'Content-Type: application/pgp-encrypted',
    'Content-Description: PGP/MIME version identification',
    '',
    'Version: 1',
  ].join(CRLF)
  const cipher = [
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    'Content-Description: OpenPGP encrypted message',
    'Content-Disposition: inline; filename="encrypted.asc"',
    '',
    armored.trim().replace(/\r?\n/g, CRLF),
  ].join(CRLF)
  return multipart(
    'multipart/encrypted',
    [version, cipher],
    '; protocol="application/pgp-encrypted"',
  )
}

/** RFC 5322 date, numeric zone rather than the obsolete "GMT". */
export function mailDate(d: Date): string {
  return d.toUTCString().replace(/GMT$/, '+0000')
}

export interface MessageHeaders {
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  subject: string
  date: Date
  messageId: string
  inReplyTo?: string[] | null
  references?: string[] | null
}

/**
 * A whole message: the headers, then the entity (whose own first lines are
 * its Content-Type). Bcc is never written — it is the envelope's business,
 * and a header carrying it would show every recipient who else was sent it.
 */
export function message(h: MessageHeaders, entity: string): string {
  const ids = (list: string[]) => list.map((id) => `<${id}>`).join(' ')
  const lines = [
    `From: ${formatAddress(h.from)}`,
    ...(h.to.length ? [`To: ${h.to.map(formatAddress).join(`,${CRLF} `)}`] : []),
    ...(h.cc.length ? [`Cc: ${h.cc.map(formatAddress).join(`,${CRLF} `)}`] : []),
    `Subject: ${encodeWords(h.subject)}`,
    `Date: ${mailDate(h.date)}`,
    `Message-ID: <${h.messageId}>`,
    ...(h.inReplyTo?.length ? [`In-Reply-To: ${ids(h.inReplyTo)}`] : []),
    ...(h.references?.length ? [`References: ${ids(h.references)}`] : []),
    'MIME-Version: 1.0',
  ]
  return `${lines.join(CRLF)}${CRLF}${entity}${CRLF}`
}
