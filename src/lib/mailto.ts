/**
 * `mailto:` URLs (RFC 6068), as the OS hands them to a registered handler.
 *
 * Deliberately not `new URL()` + `URLSearchParams`: those apply
 * form-encoding rules to the query, where `+` means a space. RFC 6068 uses
 * plain percent-encoding, so `mailto:?to=erika+news@example.com` — a perfectly
 * ordinary plus-addressed recipient — would arrive as "erika news@example.com"
 * and fail to send. Everything here is decoded with decodeURIComponent alone.
 */

export interface MailtoFields {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // A malformed escape is not worth losing the whole link over; the rest of
    // the fields are still usable and the user can fix one address by hand.
    return value
  }
}

/** Splits before decoding, so a percent-encoded comma stays inside its address. */
function addresses(list: string): string[] {
  return list
    .split(',')
    .map((a) => decode(a).trim())
    .filter(Boolean)
}

/** The fields of a `mailto:` URL, or null when it is not one. */
export function parseMailto(input: string): MailtoFields | null {
  const trimmed = input.trim()
  if (!/^mailto:/i.test(trimmed)) return null

  const rest = trimmed.slice('mailto:'.length)
  const mark = rest.indexOf('?')
  const fields: MailtoFields = {
    to: addresses(mark === -1 ? rest : rest.slice(0, mark)),
    cc: [],
    bcc: [],
    subject: '',
    body: '',
  }

  const query = mark === -1 ? '' : rest.slice(mark + 1)
  for (const pair of query ? query.split('&') : []) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const name = decode(pair.slice(0, eq)).toLowerCase()
    const value = pair.slice(eq + 1)
    // `to` may appear both before the `?` and as a field, and more than once;
    // the recipients add up rather than replacing each other.
    if (name === 'to') fields.to.push(...addresses(value))
    else if (name === 'cc') fields.cc.push(...addresses(value))
    else if (name === 'bcc') fields.bcc.push(...addresses(value))
    else if (name === 'subject') fields.subject = decode(value)
    else if (name === 'body') fields.body = decode(value)
  }
  return fields
}

/** Plain text as the composer's starting markup. */
export function textToHtml(text: string): string {
  if (!text) return ''
  return text
    .split(/\r?\n/)
    .map(
      (line) =>
        `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '<br>'}</p>`,
    )
    .join('')
}
