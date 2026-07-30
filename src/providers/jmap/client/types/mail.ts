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

export const EMAIL_BODY_PROPS = [
  'id',
  'bodyValues',
  'textBody',
  'htmlBody',
  'attachments',
  'messageId',
  'references',
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
