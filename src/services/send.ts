import type { ComposeInit } from '../app/store'
import type { EmailAddress, EmailBody, EmailHeader } from '../domain/email'
import type { Identity, OutgoingAttachment, OutgoingEmail } from '../domain/identity'
import type { MailboxRole } from '../domain/mailbox'
import { sanitizeMailHtml } from '../lib/htmlSanitize'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { connectionFor } from '../sync/connections'
import { cancel, enqueue } from '../sync/outbox'

const UNDO_SEND_MS = 10_000

const identityCache = new Map<string, Identity[]>()

export async function getIdentities(accountId: string): Promise<Identity[]> {
  const cached = identityCache.get(accountId)
  if (cached) return cached
  const conn = await connectionFor(accountId)
  const list = conn.mail ? await conn.mail.identities() : []
  identityCache.set(accountId, list)
  return list
}

async function roleMailboxId(accountId: string, role: MailboxRole): Promise<string | null> {
  const rows = await db.mailboxes
    .where('[accountId+role]')
    .equals([accountId, role ?? ''])
    .toArray()
  return rows[0]?.id ?? null
}

/** Store the file locally; upload happens at send time (works offline). */
export async function stageAttachment(accountId: string, file: File): Promise<OutgoingAttachment> {
  const localKey = crypto.randomUUID()
  const data = await file.arrayBuffer()
  await db.blobCache.put({
    accountId,
    blobId: localKey,
    size: data.byteLength,
    lastAccess: Date.now(),
    payload: sealPlain({ type: file.type || 'application/octet-stream', data }),
  })
  return {
    blobId: null,
    localKey,
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: data.byteLength,
  }
}

export interface SendResult {
  /** Cancels the send while it is still in its undo window. */
  undo: () => Promise<boolean>
}

export async function sendMail(
  accountId: string,
  identity: Identity,
  fields: {
    to: EmailAddress[]
    cc: EmailAddress[]
    bcc: EmailAddress[]
    subject: string
    html: string
    text: string
    attachments: OutgoingAttachment[]
    inReplyTo?: string[]
    references?: string[]
  },
): Promise<SendResult> {
  const drafts = await roleMailboxId(accountId, 'drafts')
  const sent = await roleMailboxId(accountId, 'sent')
  if (!drafts || !sent) throw new Error('Drafts/Sent mailbox missing')

  const mail: OutgoingEmail = {
    identityId: identity.id,
    from: { name: identity.name || null, email: identity.email },
    to: fields.to,
    cc: fields.cc,
    bcc: fields.bcc,
    subject: fields.subject,
    html: fields.html,
    text: fields.text,
    attachments: fields.attachments,
    inReplyTo: fields.inReplyTo ?? null,
    references: fields.references ?? null,
  }
  const seq = await enqueue(
    accountId,
    { kind: 'email.send', mail, mailboxIds: { drafts, sent } },
    { delayMs: UNDO_SEND_MS },
  )
  return { undo: () => cancel(seq) }
}

/**
 * What a save attempt did. The id alone cannot say: replacing an existing
 * draft answers with the id it was handed, so a failure and a success look
 * identical from outside. The autosave can ignore `ok` (it tries again on the
 * next change), the Save button cannot — it has to report rather than draw a
 * "saved" the server never agreed to.
 */
export interface DraftSaveResult {
  /** The draft's id afterwards: the new one, or the old one on failure. */
  id: string | null
  ok: boolean
}

/** Saves a draft to the server; replaces the previous one in the same call. */
export async function saveDraft(
  accountId: string,
  identity: Identity,
  fields: {
    to: EmailAddress[]
    cc: EmailAddress[]
    bcc: EmailAddress[]
    subject: string
    html: string
    text: string
    inReplyTo?: string[]
    references?: string[]
  },
  replaceId: string | null,
): Promise<DraftSaveResult> {
  const unsaved = { id: replaceId, ok: false }
  if (!navigator.onLine) return unsaved
  const drafts = await roleMailboxId(accountId, 'drafts')
  if (!drafts) return unsaved
  const conn = await connectionFor(accountId)
  if (!conn.mail) return unsaved
  const mail: OutgoingEmail = {
    identityId: identity.id,
    from: { name: identity.name || null, email: identity.email },
    to: fields.to,
    cc: fields.cc,
    bcc: fields.bcc,
    subject: fields.subject,
    html: fields.html,
    text: fields.text,
    attachments: [],
    inReplyTo: fields.inReplyTo ?? null,
    references: fields.references ?? null,
  }
  try {
    const id = await conn.mail.saveDraft(mail, drafts, replaceId)
    return id ? { id, ok: true } : unsaved
  } catch {
    return unsaved
  }
}

/** Remove an autosaved draft (after the real send is queued). */
export async function discardDraft(accountId: string, draftId: string): Promise<void> {
  await enqueue(accountId, { kind: 'email.destroy', ids: [draftId] })
  await db.emails.delete([accountId, draftId])
}

/**
 * What someone typed — or pasted — in a recipient field, as addresses.
 *
 * `Ada Lovelace <ada@example.com>` is the form every other mail client puts
 * on the clipboard, and it used to travel into the message whole: the display
 * name ended up inside the address. The server does not refuse that, it
 * writes it down — a message went out addressed to
 * `Ada Lovelace <ada@example.com` with the stray `>` as the name, and nothing
 * said so until it bounced.
 *
 * Separators inside quotes are left alone, so `"Lovelace, Ada" <ada@x>` stays
 * one recipient rather than becoming two broken ones.
 */
export function parseAddresses(input: string): EmailAddress[] {
  const parts = input.match(/(?:"[^"]*"|[^,;])+/g) ?? []
  const out: EmailAddress[] = []
  for (const part of parts) {
    const segment = part.trim()
    if (!segment.includes('@')) continue
    const angled = /^(.*)<([^<>]+)>$/.exec(segment)
    if (angled) {
      const email = angled[2]!.trim()
      if (!email.includes('@')) continue
      // Quotes are the header's own escaping, not part of the name.
      const name = angled[1]!
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim()
      out.push({ name: name || null, email })
    } else {
      out.push({ name: null, email: segment })
    }
  }
  return out
}

function quoteHeaderLine(h: EmailHeader): string {
  const from = h.from[0]
  const who = from ? (from.name ? `${from.name} <${from.email}>` : from.email) : '?'
  return `On ${new Date(h.receivedAt).toLocaleString()}, ${who} wrote:`
}

function bodyAsHtml(body: EmailBody | null): string {
  if (body?.html) return sanitizeMailHtml(body.html)
  const text = body?.text ?? ''
  return `<pre>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`
}

/**
 * A draft's stored body as editor content. Plain text becomes paragraphs and
 * line breaks rather than the `<pre>` a quoted body gets: this is text you are
 * about to go on writing, and the editor would turn a `<pre>` into a code
 * block.
 */
function draftBodyHtml(body: EmailBody | null): string {
  if (body?.html) return sanitizeMailHtml(body.html)
  const text = body?.text ?? ''
  if (!text.trim()) return ''
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/**
 * Reopens an existing draft in the compose window.
 *
 * A draft is the one message in the app that is not finished: it has to come
 * back as editable fields rather than as a rendered body, or the only thing
 * you can do with it is look at it. The draft's own id travels with it, so
 * autosave replaces that message rather than leaving a second copy behind and
 * sending destroys it (see `sendMail` plus `discardDraft` in Compose).
 *
 * Attachments come back by blob id — they already live on the server, so
 * nothing is re-uploaded; `size` is what the part reports. Inline parts
 * (`cid:`) are left out: they belong to the HTML that references them and
 * re-attaching them would duplicate them on send.
 */
export function buildDraftInit(header: EmailHeader, body: EmailBody | null): ComposeInit {
  return {
    to: header.to,
    cc: header.cc,
    // Bcc is not part of a delivered message and therefore not in the header;
    // the body fetch asks for it explicitly, and an older cached body has none.
    bcc: body?.bcc ?? [],
    subject: header.subject ?? '',
    bodyHtml: draftBodyHtml(body),
    draftId: header.id,
    inReplyTo: body?.inReplyTo ?? undefined,
    references: body?.references ?? undefined,
    attachments: (body?.attachments ?? [])
      .filter((a) => a.blobId && !a.cid)
      .map((a) => ({
        blobId: a.blobId,
        localKey: null,
        name: a.name ?? 'attachment',
        type: a.type,
        size: a.size,
      })),
  }
}

/**
 * The quoted original, header line and all.
 *
 * Exported because it is built twice: here when the body is already cached,
 * and again by the composer when it had to fetch it (see `quoteSource`).
 */
export function quoteBlock(
  header: EmailHeader,
  body: EmailBody,
  mode: 'reply' | 'replyAll' | 'forward',
): string {
  const quoted = `<blockquote>${bodyAsHtml(body)}</blockquote>`
  return mode === 'forward'
    ? `<p>---------- Forwarded message ----------<br>${quoteHeaderLine(header)}</p>${quoted}`
    : `<p>${quoteHeaderLine(header)}</p>${quoted}`
}

export function buildReply(
  accountId: string,
  header: EmailHeader,
  body: EmailBody | null,
  mode: 'reply' | 'replyAll' | 'forward',
  ownEmail: string,
): ComposeInit {
  const subjectPrefix = mode === 'forward' ? 'Fwd: ' : 'Re: '
  const baseSubject = header.subject?.replace(/^(re|fwd?):\s*/i, '') ?? ''
  /*
   * No body yet means the quote is not lost, only late: the composer opens
   * now and appends it when the fetch lands. Waiting here instead would stall
   * the window, and quoting nothing — which is what this used to do — silently
   * drops the message being answered.
   */
  const quotedHtml = body ? quoteBlock(header, body, mode) : undefined
  const quoteSource = body ? undefined : { accountId, header, mode }
  /*
   * The header first, because it is always in the local store; the body only
   * for messages whose header was cached before it carried these. Taking them
   * from the body alone meant that replying before the body had been fetched —
   * from the list by keyboard, or from a reading pane still showing its
   * skeleton — produced a message with no In-Reply-To and no References, which
   * the server has nothing to thread on.
   */
  const messageId = header.messageId ?? body?.messageId ?? null
  const references = [...(header.references ?? body?.references ?? []), ...(messageId ?? [])]

  if (mode === 'forward') {
    return {
      subject: subjectPrefix + baseSubject,
      quotedHtml,
      quoteSource,
      references: references.length ? references : undefined,
      attachments: [],
    }
  }

  const notMe = (a: EmailAddress) => a.email.toLowerCase() !== ownEmail.toLowerCase()
  const to = header.from.length ? header.from : header.to.filter(notMe)
  const cc =
    mode === 'replyAll'
      ? [...header.to, ...header.cc]
          .filter(notMe)
          .filter((a) => !to.some((t) => t.email === a.email))
      : []
  return {
    to,
    cc,
    subject: subjectPrefix + baseSubject,
    quotedHtml,
    quoteSource,
    inReplyTo: messageId ?? undefined,
    references: references.length ? references : undefined,
  }
}
