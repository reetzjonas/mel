import type { EmailBody, EmailHeader } from '../../../domain/email'
import type { Mailbox, MailboxRole } from '../../../domain/mailbox'
import type { JmapEmail, JmapEmailBodyPart, JmapMailbox } from '../client/types/mail'

const KNOWN_ROLES = new Set([
  'inbox',
  'archive',
  'drafts',
  'sent',
  'trash',
  'junk',
  'all',
  'flagged',
  'important',
  'subscribed',
])

export function toMailbox(m: JmapMailbox): Mailbox {
  return {
    id: m.id,
    parentId: m.parentId,
    name: m.name,
    role: (m.role && KNOWN_ROLES.has(m.role) ? m.role : null) as MailboxRole,
    sortOrder: m.sortOrder ?? 0,
    totalEmails: m.totalEmails ?? 0,
    unreadEmails: m.unreadEmails ?? 0,
    totalThreads: m.totalThreads ?? 0,
    unreadThreads: m.unreadThreads ?? 0,
    mayReadItems: m.myRights?.mayReadItems ?? true,
    mayAddItems: m.myRights?.mayAddItems ?? true,
    mayRemoveItems: m.myRights?.mayRemoveItems ?? true,
    mayCreateChild: m.myRights?.mayCreateChild ?? true,
    mayRename: m.myRights?.mayRename ?? true,
    mayDelete: m.myRights?.mayDelete ?? true,
  }
}

function toTrueRecord(r: Record<string, boolean> | undefined): Record<string, true> {
  const out: Record<string, true> = {}
  for (const [k, v] of Object.entries(r ?? {})) if (v) out[k] = true
  return out
}

export function toEmailHeader(e: JmapEmail): EmailHeader {
  return {
    id: e.id,
    threadId: e.threadId,
    mailboxIds: toTrueRecord(e.mailboxIds),
    keywords: toTrueRecord(e.keywords),
    from: (e.from ?? []).map((a) => ({ name: a.name, email: a.email })),
    to: (e.to ?? []).map((a) => ({ name: a.name, email: a.email })),
    cc: (e.cc ?? []).map((a) => ({ name: a.name, email: a.email })),
    subject: e.subject ?? null,
    receivedAt: e.receivedAt,
    sentAt: e.sentAt ?? null,
    preview: e.preview ?? '',
    hasAttachment: e.hasAttachment ?? false,
    size: e.size,
    messageId: e.messageId ?? null,
    references: e.references ?? null,
  }
}

function partText(e: JmapEmail, parts: JmapEmailBodyPart[] | undefined): string | null {
  if (!parts?.length) return null
  const chunks: string[] = []
  for (const p of parts) {
    if (p.partId != null) {
      const v = e.bodyValues?.[p.partId]
      if (v) chunks.push(v.value)
    }
  }
  return chunks.length ? chunks.join('\n') : null
}

/**
 * Per RFC 8621 §4.1.4, a message with no real HTML part still gets a
 * `htmlBody` — the server is allowed to point it at the same plain-text part
 * as `textBody` rather than leave it empty. Stalwart does exactly that, so
 * `htmlBody` alone cannot tell "real HTML" from "plain text mirrored in both
 * lists" apart; only the part's own `type` can. Without this check every
 * plain-text message was treated as HTML mail, which always renders on a
 * fixed white background (see mailFrameDoc) — so plain text never picked up
 * the app's dark theme in the reading pane.
 */
function htmlPartText(e: JmapEmail, parts: JmapEmailBodyPart[] | undefined): string | null {
  if (!parts?.length || !parts.every((p) => p.type?.toLowerCase().startsWith('text/html'))) {
    return null
  }
  return partText(e, parts)
}

export function toEmailBody(e: JmapEmail): EmailBody {
  return {
    emailId: e.id,
    html: htmlPartText(e, e.htmlBody),
    text: partText(e, e.textBody),
    bcc: (e.bcc ?? []).map((a) => ({ name: a.name, email: a.email })),
    messageId: e.messageId ?? null,
    references: e.references ?? null,
    inReplyTo: e.inReplyTo ?? null,
    attachments: (e.attachments ?? []).map((p) => ({
      partId: p.partId,
      blobId: p.blobId,
      type: p.type,
      name: p.name,
      disposition: p.disposition,
      cid: p.cid,
      size: p.size,
    })),
  }
}
