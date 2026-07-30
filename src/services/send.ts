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
  const rows = await db.mailboxes.where('[accountId+role]').equals([accountId, role ?? '']).toArray()
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

/** Autosave a draft to the server; replaces the previous autosave. */
export async function saveDraft(
  accountId: string,
  identity: Identity,
  fields: {
    to: EmailAddress[]
    cc: EmailAddress[]
    subject: string
    html: string
    text: string
    inReplyTo?: string[]
    references?: string[]
  },
  replaceId: string | null,
): Promise<string | null> {
  if (!navigator.onLine) return replaceId
  const drafts = await roleMailboxId(accountId, 'drafts')
  if (!drafts) return replaceId
  const conn = await connectionFor(accountId)
  if (!conn.mail) return replaceId
  const mail: OutgoingEmail = {
    identityId: identity.id,
    from: { name: identity.name || null, email: identity.email },
    to: fields.to,
    cc: fields.cc,
    bcc: [],
    subject: fields.subject,
    html: fields.html,
    text: fields.text,
    attachments: [],
    inReplyTo: fields.inReplyTo ?? null,
    references: fields.references ?? null,
  }
  try {
    return (await conn.mail.saveDraft(mail, drafts, replaceId)) ?? replaceId
  } catch {
    return replaceId
  }
}

/** Remove an autosaved draft (after the real send is queued). */
export async function discardDraft(accountId: string, draftId: string): Promise<void> {
  await enqueue(accountId, { kind: 'email.destroy', ids: [draftId] })
  await db.emails.delete([accountId, draftId])
}

export function parseAddresses(input: string): EmailAddress[] {
  return input
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.includes('@'))
    .map((email) => ({ name: null, email }))
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

export function buildReply(
  header: EmailHeader,
  body: EmailBody | null,
  mode: 'reply' | 'replyAll' | 'forward',
  ownEmail: string,
): ComposeInit {
  const subjectPrefix = mode === 'forward' ? 'Fwd: ' : 'Re: '
  const baseSubject = header.subject?.replace(/^(re|fwd?):\s*/i, '') ?? ''
  const quoted = `<blockquote>${bodyAsHtml(body)}</blockquote>`
  const references = [...(body?.references ?? []), ...(body?.messageId ?? [])]

  if (mode === 'forward') {
    return {
      subject: subjectPrefix + baseSubject,
      quotedHtml: `<p>---------- Forwarded message ----------<br>${quoteHeaderLine(header)}</p>${quoted}`,
      references: references.length ? references : undefined,
      attachments: [],
    }
  }

  const notMe = (a: EmailAddress) => a.email.toLowerCase() !== ownEmail.toLowerCase()
  const to = header.from.length ? header.from : header.to.filter(notMe)
  const cc =
    mode === 'replyAll' ? [...header.to, ...header.cc].filter(notMe).filter((a) => !to.some((t) => t.email === a.email)) : []
  return {
    to,
    cc,
    subject: subjectPrefix + baseSubject,
    quotedHtml: `<p>${quoteHeaderLine(header)}</p>${quoted}`,
    inReplyTo: body?.messageId ?? undefined,
    references: references.length ? references : undefined,
  }
}
