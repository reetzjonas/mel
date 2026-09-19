import type { EventLinks } from '../domain/calendar'
import { toAlerts } from './alerts'

/**
 * Event attachments, as JSCalendar carries them: entries of the `links` map
 * whose `rel` is "enclosure" (RFC 8984 §4.2.7).
 *
 * An attachment is one of three things, told apart by what the link holds:
 *
 * - **embedded** — `href` is a `data:` URI with the bytes inside. It travels
 *   with the invitation, so an attendee on another server gets it too, and it
 *   opens without a request. Every byte also rides along in each sync of the
 *   event, which is why `MAX_EMBEDDED_BYTES` is small.
 * - **file** — a reference to a file in Files: the link's `blobId` names the
 *   content, and `href` is that blob's download URL. Costs nothing to sync, but
 *   only mel on the same account can open it, and editing the file in Files
 *   gives it a new blob id, which leaves the link dead.
 * - **web** — a plain `http(s)` link another client attached.
 *
 * Stalwart drops a link that has a `blobId` but no `href`, so a file reference
 * cannot be sent as a blob id alone.
 */

/** Larger files are referenced from Files instead of being embedded. */
export const MAX_EMBEDDED_BYTES = 1_000_000

export type AttachmentSource = 'embedded' | 'file' | 'web'

export interface Attachment {
  /** Key in the links map. */
  id: string
  name: string
  href: string
  contentType: string
  size: number | null
  blobId: string | null
  source: AttachmentSource
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function nameFromHref(href: string): string {
  try {
    const last = new URL(href).pathname.split('/').filter(Boolean).at(-1)
    return last ? decodeURIComponent(last) : href
  } catch {
    return href
  }
}

/** The attachments in a links map; anything else in it is ignored, not dropped. */
export function attachmentsOf(links: EventLinks | undefined): Attachment[] {
  const out: Attachment[] = []
  for (const [id, link] of Object.entries(links ?? {})) {
    if (link['rel'] !== 'enclosure' || !isText(link['href'])) continue
    const href = link['href']
    const blobId = isText(link['blobId']) ? link['blobId'] : null
    let source: AttachmentSource
    if (/^data:/i.test(href)) source = 'embedded'
    else if (blobId) source = 'file'
    // An allow list: this is somebody else's data and it becomes an href.
    else if (/^https?:\/\//i.test(href)) source = 'web'
    else continue
    out.push({
      id,
      name: isText(link['title']) ? link['title'] : nameFromHref(href),
      href,
      contentType: isText(link['contentType']) ? link['contentType'] : 'application/octet-stream',
      size: typeof link['size'] === 'number' ? link['size'] : null,
      blobId,
      source,
    })
  }
  return out
}

/** Bytes to base64, in slices — spreading a megabyte into one call overflows the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** The link entry for a small file whose bytes go into the event itself. */
export function embeddedLink(name: string, contentType: string, bytes: Uint8Array) {
  return {
    '@type': 'Link',
    rel: 'enclosure',
    href: `data:${contentType};base64,${toBase64(bytes)}`,
    contentType,
    size: bytes.length,
    title: name,
  }
}

/** The link entry for a file that stays in Files. */
export function fileLink(file: {
  name: string
  contentType: string
  size: number | null
  blobId: string
  href: string
}) {
  return {
    '@type': 'Link',
    rel: 'enclosure',
    href: file.href,
    blobId: file.blobId,
    contentType: file.contentType,
    ...(file.size === null ? {} : { size: file.size }),
    title: file.name,
  }
}

/** A `data:` URI's bytes and type, or null when it is not one mel can read. */
export function decodeDataUri(href: string): { type: string; bytes: Uint8Array } | null {
  const m = /^data:([^,]*),(.*)$/is.exec(href)
  if (!m) return null
  const params = m[1]!.split(';')
  const type = params[0] || 'text/plain'
  try {
    if (params.includes('base64')) {
      const binary = atob(decodeURIComponent(m[2]!))
      return { type, bytes: Uint8Array.from(binary, (c) => c.charCodeAt(0)) }
    }
    return { type, bytes: new TextEncoder().encode(decodeURIComponent(m[2]!)) }
  } catch {
    return null
  }
}

/** A fresh key for a new entry, unlikely to meet one another client chose. */
export function newLinkId(links: EventLinks | undefined): string {
  let id: string
  do id = `a${crypto.randomUUID().slice(0, 8)}`
  while (links && id in links)
  return id
}

export function withLink(
  links: EventLinks | undefined,
  id: string,
  link: Record<string, unknown>,
): EventLinks {
  return { ...links, [id]: link }
}

export function withoutLink(links: EventLinks | undefined, id: string): EventLinks {
  const { [id]: _removed, ...rest } = links ?? {}
  return rest
}

/** The links a server sent, keeping every entry that is an object. */
export const toLinks = (raw: unknown): EventLinks => toAlerts(raw)
