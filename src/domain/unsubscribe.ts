/**
 * What a newsletter offers as a way out (RFC 2369 List-Unsubscribe, RFC 8058
 * List-Unsubscribe-Post).
 *
 * Provider-agnostic and pure: the server hands over the header's URLs, this
 * decides what can actually be done with them, and the UI only picks between
 * the ways that are left.
 */
export interface Unsubscribe {
  /**
   * https: links, in header order. Only https — a one-click unsubscribe is a
   * POST carrying an address someone wants to keep to themselves, and RFC
   * 8058 requires https for exactly that reason. A plain http link is dropped
   * rather than offered.
   */
  https: string[]
  /** mailto: links, in header order. */
  mailto: string[]
  /**
   * The sender states that a bare POST to the https link is enough, so it can
   * be done without handing the reader off to a web page (RFC 8058).
   */
  oneClick: boolean
}

/** RFC 8058 spells the value out exactly; anything else is not a promise. */
const ONE_CLICK = 'list-unsubscribe=one-click'

/**
 * Null unless there is something a reader could actually press.
 *
 * A List-Unsubscribe header with nothing but an http: link, or a malformed
 * one, comes back as null: an "Unsubscribe" button that cannot unsubscribe is
 * worse than none, because it costs the reader the click to find out.
 */
export function parseUnsubscribe(urls: string[] | null, post: string | null): Unsubscribe | null {
  const https: string[] = []
  const mailto: string[] = []
  for (const raw of urls ?? []) {
    // The header form is <url>, and a server that hands the value over
    // unparsed keeps those brackets; so does a stray space around it.
    const url = raw.trim().replace(/^<|>$/g, '').trim()
    if (/^https:\/\/\S+$/i.test(url)) https.push(url)
    else if (/^mailto:\S+$/i.test(url)) mailto.push(url)
  }
  if (!https.length && !mailto.length) return null
  // One-click is meaningless without an https link to post to.
  const oneClick = https.length > 0 && (post ?? '').trim().toLowerCase() === ONE_CLICK
  return { https, mailto, oneClick }
}

export interface MailtoFields {
  to: string
  subject: string
  body: string
}

/**
 * The parts of a mailto: unsubscribe link, for handing to the composer.
 *
 * Sending it from the app rather than the operating system's mail client:
 * this *is* the mail client, and the address the list expects to hear from is
 * the one it is signed in as.
 */
export function parseMailto(url: string): MailtoFields | null {
  const match = /^mailto:([^?]*)(?:\?(.*))?$/i.exec(url.trim())
  if (!match) return null
  const to = decodeURIComponent(match[1] ?? '').trim()
  if (!to) return null
  const params = new URLSearchParams(match[2] ?? '')
  return {
    to,
    // Senders commonly expect a specific word, and some ignore the mail
    // without it, so whatever they asked for is carried through verbatim.
    subject: params.get('subject') ?? 'Unsubscribe',
    body: params.get('body') ?? '',
  }
}
