import type { Unsubscribe } from './unsubscribe'

export interface EmailAddress {
  name: string | null
  email: string
}

/**
 * Header-level view of a message: enough for list rendering and notification
 * diffing. Bodies are fetched lazily (see EmailBody).
 */
export interface EmailHeader {
  id: string
  threadId: string
  /** mailboxId → true (JMAP semantics: a message can be in several mailboxes). */
  mailboxIds: Record<string, true>
  /** Keywords like $seen, $flagged, $draft, $answered. */
  keywords: Record<string, true>
  from: EmailAddress[]
  to: EmailAddress[]
  cc: EmailAddress[]
  subject: string | null
  /** ISO 8601 UTC. */
  receivedAt: string
  sentAt: string | null
  preview: string
  hasAttachment: boolean
  size: number
  /*
   * RFC 5322 Message-ID and References of this message, needed to thread a
   * reply. Optional because headers cached before they were fetched simply do
   * not carry them; `buildReply` falls back to the body for those.
   */
  messageId?: string[] | null
  references?: string[] | null
}

export interface EmailBodyPart {
  partId: string | null
  blobId: string | null
  type: string
  name: string | null
  disposition: string | null
  cid: string | null
  size: number
}

/** Lazily fetched full body, cached separately from headers. */
export interface EmailBody {
  emailId: string
  html: string | null
  text: string | null
  /*
   * Only a draft ever needs this — the recipients of a message you received
   * are in its header, but Bcc is not part of what is delivered, so reopening
   * your own unsent draft is the one case where it has to come along. Optional
   * because bodies cached before this existed simply do not carry it.
   */
  bcc?: EmailAddress[] | null
  attachments: EmailBodyPart[]
  /** RFC 5322 Message-ID(s), needed for reply threading. */
  messageId: string[] | null
  references: string[] | null
  /** What this message answers — carried along when a draft is reopened. */
  inReplyTo?: string[] | null
  /**
   * The way out of a mailing list, when the message offers one. Optional
   * because bodies cached before this existed simply do not carry it.
   */
  unsubscribe?: Unsubscribe | null
}

export interface Thread {
  id: string
  emailIds: string[]
}

export const Keyword = {
  seen: '$seen',
  flagged: '$flagged',
  draft: '$draft',
  answered: '$answered',
  forwarded: '$forwarded',
} as const

/** Narrows a folder to part of its contents; undefined shows everything. */
export type MailFilter = 'unread' | 'flagged'

export function matchesFilter(header: EmailHeader, filter: MailFilter | undefined): boolean {
  if (filter === 'unread') return !header.keywords[Keyword.seen]
  if (filter === 'flagged') return Boolean(header.keywords[Keyword.flagged])
  return true
}
