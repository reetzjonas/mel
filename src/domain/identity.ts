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
  /**
   * Set for a picture drawn inside the HTML (`<img src="cid:…">`) rather than
   * attached beside it: it goes out with `Content-Disposition: inline` and
   * this Content-ID. See lib/inlineImages.ts.
   */
  cid?: string | null
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
