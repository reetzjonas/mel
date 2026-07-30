import type { EmailAddress } from './email'

export interface Identity {
  id: string
  name: string
  email: string
  replyTo: EmailAddress[] | null
}

export interface OutgoingAttachment {
  /** Server blob id once uploaded; local drafts may carry raw bytes instead. */
  blobId: string | null
  /** Key into blobCache while the attachment is only local. */
  localKey: string | null
  name: string
  type: string
  size: number
}

export interface OutgoingEmail {
  identityId: string
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  subject: string
  text: string
  html: string
  attachments: OutgoingAttachment[]
  inReplyTo: string[] | null
  references: string[] | null
}
