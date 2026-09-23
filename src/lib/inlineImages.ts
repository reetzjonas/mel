import type { EmailBody, EmailBodyPart } from '../domain/email'
import type { OutgoingAttachment } from '../domain/identity'

/*
 * Inline images: pictures that travel inside a message and are referenced from
 * its HTML as `<img src="cid:…">` (RFC 2392), rather than attached beside it
 * or loaded from the web.
 *
 * The HTML keeps the `cid:` reference in every copy that leaves mel — the sent
 * message, a saved draft — and only what is on screen swaps it for something a
 * browser can draw. Kept apart from both ends so the reading pane and the
 * composer agree on what counts as a reference.
 */

const CID_SRC = /(\bsrc\s*=\s*)(["'])cid:([^"']+)\2/gi

/** A Content-ID for a picture mel adds; the domain part only has to be unique-looking. */
export function newCid(): string {
  return `${crypto.randomUUID()}@mel`
}

/** A cid as it is written in a URL: percent-decoded, without angle brackets. */
function normalise(cid: string): string {
  let value = cid.trim()
  try {
    value = decodeURIComponent(value)
  } catch {
    // A stray % is not an encoding; take the value as it stands.
  }
  return value.replace(/^<|>$/g, '')
}

/** The Content-IDs an HTML body refers to. */
export function referencedCids(html: string): Set<string> {
  const out = new Set<string>()
  for (const m of html.matchAll(CID_SRC)) out.add(normalise(m[3]!))
  return out
}

/**
 * The body with each `cid:` reference that has a URL in `urls` pointed at it.
 * References without one are left as they are, so a picture still loading or
 * gone missing stays a broken image rather than vanishing from the markup.
 */
export function resolveCids(html: string, urls: Record<string, string>): string {
  return html.replace(CID_SRC, (whole, attr: string, quote: string, cid: string) => {
    const url = urls[normalise(cid)]
    return url ? `${attr}${quote}${url}${quote}` : whole
  })
}

/** Whether a MIME type is a picture a browser draws inline. */
export function isInlineImageType(type: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i.test(type)
}

/** A part's Content-ID without the angle brackets some servers keep. */
export function partCid(part: EmailBodyPart): string | null {
  return part.cid ? part.cid.replace(/^<|>$/g, '') : null
}

/** The parts an HTML body draws inline, by the cid it refers to them with. */
export function inlineParts(body: EmailBody): Map<string, EmailBodyPart> {
  const out = new Map<string, EmailBodyPart>()
  if (!body.html) return out
  const wanted = referencedCids(body.html)
  for (const part of body.attachments) {
    const cid = partCid(part)
    if (cid && part.blobId && wanted.has(cid)) out.set(cid, part)
  }
  return out
}

/**
 * The same parts as outgoing inline pictures, reusing the blob on the server:
 * what a reopened draft, a reply or a forward carries along for its quote.
 */
export function inlineAttachments(body: EmailBody): OutgoingAttachment[] {
  return [...inlineParts(body)].map(([cid, part]) => ({
    blobId: part.blobId,
    localKey: null,
    name: part.name ?? cid,
    type: part.type,
    size: part.size,
    cid,
  }))
}

/**
 * The inline pictures a finished body still refers to. One whose `<img>` was
 * deleted while writing would otherwise go out as an invisible part.
 */
export function stillReferenced(html: string, images: OutgoingAttachment[]): OutgoingAttachment[] {
  const wanted = referencedCids(html)
  return images.filter((a) => a.cid && wanted.has(a.cid))
}
