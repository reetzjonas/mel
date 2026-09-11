import type { DragEvent } from 'react'

/*
 * What the mail list and the folder tree hand each other during a drag.
 *
 * Two MIME types rather than one with a discriminator inside, because the type
 * is the *only* thing a drop target may read while the drag is in flight: the
 * browser withholds the data itself until the drop, so "may I take this?" has
 * to be answerable from the type alone. Anything a target needs before then —
 * which folder the mail comes from, say — it cannot have, which is why the
 * same-folder drop is turned away on arrival rather than refused in advance.
 */
export const MAIL_DRAG = 'application/x-mel-mail'
export const FOLDER_DRAG = 'application/x-mel-folder'

export interface MailDrag {
  /** The folder being dragged out of, so a drop onto it can do nothing. */
  mailboxId: string
  /** This folder's share of the row: a conversation moves what it shows. */
  ids: string[]
}

export function setMailDrag(e: DragEvent, payload: MailDrag): void {
  e.dataTransfer.setData(MAIL_DRAG, JSON.stringify(payload))
  e.dataTransfer.effectAllowed = 'move'
}

export function readMailDrag(e: DragEvent): MailDrag | null {
  const raw = e.dataTransfer.getData(MAIL_DRAG)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as MailDrag
    return Array.isArray(value.ids) && value.ids.length ? value : null
  } catch {
    return null
  }
}

export function setFolderDrag(e: DragEvent, mailboxId: string): void {
  e.dataTransfer.setData(FOLDER_DRAG, mailboxId)
  e.dataTransfer.effectAllowed = 'move'
}

/** What is being dragged, from the types alone — all a dragover may look at. */
export function dragKind(e: DragEvent): 'mail' | 'folder' | null {
  const types = e.dataTransfer.types
  if (types.includes(MAIL_DRAG)) return 'mail'
  if (types.includes(FOLDER_DRAG)) return 'folder'
  return null
}
