// JMAP Mail types (RFC 8621), subset used by the provider.

export interface JmapMailbox {
  id: string
  name: string
  parentId: string | null
  role: string | null
  sortOrder: number
  totalEmails: number
  unreadEmails: number
  totalThreads: number
  unreadThreads: number
  myRights: {
    mayReadItems: boolean
    mayAddItems: boolean
    mayRemoveItems: boolean
    maySetSeen: boolean
    maySetKeywords: boolean
    mayCreateChild: boolean
    mayRename: boolean
    mayDelete: boolean
    maySubmit: boolean
  }
  isSubscribed: boolean
}

export interface JmapEmailAddress {
  name: string | null
  email: string
}

export interface JmapEmailBodyPart {
  partId: string | null
  blobId: string | null
  size: number
  name: string | null
  type: string
  charset?: string | null
  disposition: string | null
  cid: string | null
  subParts?: JmapEmailBodyPart[] | null
}

export interface JmapEmailBodyValue {
  value: string
  isEncodingProblem?: boolean
  isTruncated?: boolean
}

export interface JmapEmail {
  id: string
  blobId: string
  threadId: string
  messageId?: string[] | null
  references?: string[] | null
  inReplyTo?: string[] | null
  mailboxIds: Record<string, boolean>
  keywords: Record<string, boolean>
  size: number
  receivedAt: string
  sentAt?: string | null
  from?: JmapEmailAddress[] | null
  to?: JmapEmailAddress[] | null
  cc?: JmapEmailAddress[] | null
  bcc?: JmapEmailAddress[] | null
  replyTo?: JmapEmailAddress[] | null
  subject?: string | null
  preview?: string
  hasAttachment?: boolean
  bodyValues?: Record<string, JmapEmailBodyValue>
  textBody?: JmapEmailBodyPart[]
  htmlBody?: JmapEmailBodyPart[]
  attachments?: JmapEmailBodyPart[]
  /** Raw header list, only requested for the metadata view. */
  headers?: Array<{ name: string; value: string }> | null
}

export interface JmapThread {
  id: string
  emailIds: string[]
}

/** Header-level properties fetched during sync; bodies are fetched on demand. */
export const EMAIL_HEADER_PROPS = [
  'id',
  'blobId',
  'threadId',
  'mailboxIds',
  'keywords',
  'size',
  'receivedAt',
  'sentAt',
  'from',
  'to',
  'cc',
  'subject',
  'preview',
  'hasAttachment',
] as const

/**
 * Everything the metadata view needs: the raw headers, plus the blob id that
 * makes the original message downloadable. Kept apart from the header and body
 * property sets because a full header list is far too much to sync per message.
 */
export const EMAIL_METADATA_PROPS = ['id', 'blobId', 'headers'] as const

export const EMAIL_BODY_PROPS = [
  'id',
  // For reopening a draft: Bcc never travels with a delivered message, so it
  // is not in the header property set and can only be read back here.
  'bcc',
  'bodyValues',
  'textBody',
  'htmlBody',
  'attachments',
  'messageId',
  'references',
  // Threading for a draft picked up again: the reply it belongs to is only
  // recorded here, nowhere in the header the list is built from.
  'inReplyTo',
] as const

export interface EmailFilterCondition {
  inMailbox?: string
  inMailboxOtherThan?: string[]
  text?: string
  from?: string
  to?: string
  subject?: string
  body?: string
  hasKeyword?: string
  notKeyword?: string
  hasAttachment?: boolean
  before?: string
  after?: string
}

export interface FilterOperator<C> {
  operator: 'AND' | 'OR' | 'NOT'
  conditions: Array<C | FilterOperator<C>>
}

export type EmailFilter = EmailFilterCondition | FilterOperator<EmailFilterCondition>

export interface Comparator {
  property: string
  isAscending?: boolean
  keyword?: string
}
