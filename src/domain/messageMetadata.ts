/**
 * A message's own metadata: the headers the server carries for it, and what can
 * be read out of them about how it travelled and whether it was authenticated.
 *
 * Everything here is pure and provider-agnostic. Header parsing is deliberately
 * forgiving: these fields are written by thousands of different agents and no
 * regex survives all of them, so every derived value sits next to the raw line
 * it came from. A field this code fails to read is a field the reader can still
 * see for themselves.
 */

/** One header exactly as the server reports it — the value may be folded. */
export interface RawHeader {
  name: string
  value: string
}

export interface MessageMetadata {
  /** Every header of the message, topmost first. */
  headers: RawHeader[]
  /** The whole message as a blob, for downloading the original. */
  blobId: string | null
}

/**
 * RFC 5322 unfolding: a long header value is broken across lines, each
 * continuation starting with space or tab. Servers also tend to include the
 * space that follows the colon, so the result is trimmed.
 */
export function unfoldHeader(value: string): string {
  return value.replace(/\r?\n[ \t]+/g, ' ').trim()
}

/** The first value of a header, unfolded. Names are case-insensitive. */
export function headerValue(headers: RawHeader[], name: string): string | null {
  const wanted = name.toLowerCase()
  for (const header of headers) {
    if (header.name.toLowerCase() === wanted) return unfoldHeader(header.value)
  }
  return null
}

/** Every value of a repeated header (Received, Authentication-Results …). */
export function headerValues(headers: RawHeader[], name: string): string[] {
  const wanted = name.toLowerCase()
  return headers
    .filter((header) => header.name.toLowerCase() === wanted)
    .map((header) => unfoldHeader(header.value))
}

/** One `Received:` line, as much of it as could be read. */
export interface DeliveryHop {
  /** The host that handed the message over. */
  from: string | null
  /** Its IP, when the receiving server noted one. */
  ip: string | null
  /** The host that took it. */
  by: string | null
  /** ESMTP, ESMTPS, local … */
  protocol: string | null
  /** The timestamp this hop recorded, as written. */
  at: string | null
  /** The whole line, unfolded — the answer to anything not parsed above. */
  raw: string
}

/** Parenthesised comments, which may contain the very words we scan for. */
const COMMENT = /\([^()]*\)/g
const IP = /\[(?:IPv6:)?([0-9a-fA-F.:]+)\]/
const CLAUSE = /(?:^|\s)(from|by|with)\s+([^\s;()]+)/g

/**
 * The path a message took, in transit order: the machine it started on first.
 *
 * `Received:` headers are *prepended* by each hop, so the list arrives newest
 * first and has to be reversed to read as a journey. The timestamp is whatever
 * follows the final semicolon, and clauses are matched only outside comments —
 * `(from userid 1000)` would otherwise look like a hop's origin.
 */
export function deliveryPath(headers: RawHeader[]): DeliveryHop[] {
  return headerValues(headers, 'Received')
    .map((raw) => {
      const semicolon = raw.lastIndexOf(';')
      const head = semicolon === -1 ? raw : raw.slice(0, semicolon)
      const at = semicolon === -1 ? null : raw.slice(semicolon + 1).trim() || null
      const ip = IP.exec(head)?.[1] ?? null
      const clauses = new Map<string, string>()
      for (const [, key, value] of head.replace(COMMENT, ' ').matchAll(CLAUSE)) {
        if (key && value && !clauses.has(key)) clauses.set(key, value)
      }
      return {
        from: clauses.get('from') ?? null,
        ip,
        by: clauses.get('by') ?? null,
        protocol: clauses.get('with') ?? null,
        at,
        raw,
      }
    })
    .reverse()
}

/** One verdict of the receiving server: `spf=pass`, `dkim=fail`, … */
export interface AuthResult {
  method: string
  result: string
  /**
   * What the verdict applies to, as `property=value`
   * (`smtp.helo=mta.example.com`). Two SPF results on one message are the
   * normal case rather than a contradiction, and this is the difference
   * between them.
   */
  identity: string | null
}

/*
 * A method has to stand on its own. `\b` would also match inside
 * `policy.dmarc=quarantine` — which is the *policy the sender published*, not a
 * verdict, and reading it as one puts a second, worse-looking "dmarc" line next
 * to the real result. A separator class rather than a lookbehind: Safari below
 * 16.4 throws on lookbehind while *parsing* the file, taking the app with it.
 */
const AUTH_METHOD = /(?:^|[\s;])(spf|dkim|dmarc|arc|iprev|auth|dkim-atps)=([a-z]+)\b/i
const AUTH_PROPERTY = /(?:^|\s)([a-z]+\.[a-z-]+)=("?)([^\s;"]+)\2/gi
const SPF_RESULT = /^\s*([a-z]+)/i
const SPF_IDENTITY = /\b(envelope-from|helo)=("?)([^\s;"]+)\2/i

/**
 * Which property names an identity, per method, most specific first. Everything
 * else in a clause (`policy.*`, `header.b`, reason strings) describes how the
 * check went, not what it was about.
 */
const IDENTITY_PROPERTIES: Record<string, string[]> = {
  spf: ['smtp.mailfrom', 'smtp.helo'],
  dkim: ['header.d', 'header.i'],
  dmarc: ['header.from'],
  iprev: ['policy.iprev'],
}

/**
 * What the receiving server made of the sender's authentication.
 *
 * Read from `Authentication-Results`, which states one `method=result` per
 * clause, clauses separated by semicolons, each followed by the properties it
 * applies to. Several clauses for the same method are normal — SPF is evaluated
 * against the HELO name *and* the envelope sender — so verdicts are folded only
 * when method, result and identity all agree. "Passed for one identity, failed
 * for the other" is exactly what someone opens this view to see, and without the
 * identity beside it the two lines look like the server contradicting itself.
 *
 * `Received-SPF` is a fallback for servers that write it but no
 * `Authentication-Results`; it is skipped when SPF was already reported, or the
 * same verdict would appear twice under different spellings.
 */
export function authResults(headers: RawHeader[]): AuthResult[] {
  const out: AuthResult[] = []
  const seen = new Set<string>()
  const push = (method: string, result: string, identity: string | null) => {
    const key = `${method}=${result}/${identity ?? ''}`.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ method: method.toLowerCase(), result: result.toLowerCase(), identity })
  }

  for (const value of headerValues(headers, 'Authentication-Results')) {
    // Comments hold explanations that can themselves contain "spf=..." text,
    // and a semicolon inside one would split a clause in the wrong place.
    for (const clause of value.replace(COMMENT, ' ').split(';')) {
      const [, method, result] = AUTH_METHOD.exec(clause) ?? []
      if (!method || !result) continue
      const properties = new Map(
        [...clause.matchAll(AUTH_PROPERTY)].map(([, name, , content]) => [
          name!.toLowerCase(),
          content!,
        ]),
      )
      const wanted = IDENTITY_PROPERTIES[method.toLowerCase()] ?? []
      const name = wanted.find((property) => properties.has(property))
      push(method, result, name ? `${name}=${properties.get(name)}` : null)
    }
  }

  if (!out.some((entry) => entry.method === 'spf')) {
    const spf = headerValue(headers, 'Received-SPF')
    const result = spf && SPF_RESULT.exec(spf)?.[1]
    if (spf && result) {
      const [, property, , content] = SPF_IDENTITY.exec(spf) ?? []
      push('spf', result, property && content ? `${property.toLowerCase()}=${content}` : null)
    }
  }

  return out
}

/**
 * Headers worth naming in their own right, in display order — the ones people
 * come looking for. Everything else is still listed raw below them, so this is
 * a shortcut, not a filter.
 */
export const NOTABLE_HEADERS = [
  'Message-ID',
  'In-Reply-To',
  'References',
  'Return-Path',
  'Reply-To',
  'Sender',
  'List-Id',
  'List-Unsubscribe',
  'X-Mailer',
  'User-Agent',
  'Auto-Submitted',
  'Precedence',
] as const

export function notableHeaders(headers: RawHeader[]): RawHeader[] {
  const out: RawHeader[] = []
  for (const name of NOTABLE_HEADERS) {
    const value = headerValue(headers, name)
    if (value) out.push({ name, value })
  }
  return out
}

/**
 * A file name for the downloaded original.
 *
 * The subject comes from the sender, so it is treated as hostile input: path
 * separators, control characters and leading dots are removed (a name like
 * `../../x` or `.eml` is a download the user did not ask for), and the rest is
 * cut to a length every filesystem accepts.
 */
export function emlFileName(subject: string | null): string {
  const base = (subject ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 60)
    .trim()
  return `${base || 'message'}.eml`
}

/** The headers as text, one per line — what "copy" and "export" hand over. */
export function headersAsText(headers: RawHeader[]): string {
  return headers.map((header) => `${header.name}: ${unfoldHeader(header.value)}`).join('\n')
}
