export type MailboxRole =
  | 'inbox'
  | 'archive'
  | 'drafts'
  | 'sent'
  | 'trash'
  | 'junk'
  | 'all'
  | 'flagged'
  | 'important'
  | 'subscribed'
  | null

export interface Mailbox {
  id: string
  parentId: string | null
  name: string
  role: MailboxRole
  sortOrder: number
  totalEmails: number
  unreadEmails: number
  totalThreads: number
  unreadThreads: number
  /** Rights subset we care about (JMAP myRights). */
  mayReadItems: boolean
  mayAddItems: boolean
  mayRemoveItems: boolean
  mayCreateChild: boolean
  mayRename: boolean
  mayDelete: boolean
}
