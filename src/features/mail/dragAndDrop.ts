import type { DragEvent, MouseEvent } from 'react'

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

/*
 * Without this, the browser's default drag image is a full snapshot of the
 * row being dragged — for a mail row, wide enough to cover the sidebar it
 * needs to be dropped on, leaving no way to see which folder is underneath.
 * A small label tracking near the cursor's edge, rather than centred under
 * it, keeps the drop target beside the pointer visible throughout the drag.
 */
function setDragLabel(e: DragEvent, label: string): void {
  const el = document.createElement('div')
  el.textContent = label
  el.className =
    'pointer-events-none fixed top-0 left-0 max-w-[180px] truncate rounded-control bg-surface-2 px-2.5 py-1.5 text-[13px] text-ink shadow-raised'
  // Off-screen but still rendered, which is all setDragImage needs.
  el.style.transform = 'translate(-9999px, -9999px)'
  document.body.appendChild(el)
  // A negative hotspot places the image's top-left *past* the cursor, i.e.
  // down and to the right of it — the trailing side when dragging from the
  // mail list or a folder row towards the sidebar above and to the left.
  e.dataTransfer.setDragImage(el, -12, -12)
  setTimeout(() => el.remove(), 0)
}

export function setMailDrag(e: DragEvent, payload: MailDrag, label: string): void {
  const json = JSON.stringify(payload)
  e.dataTransfer.setData(MAIL_DRAG, json)
  // WebKit drops custom-type data set during a touch-started drag: getData
  // comes back empty on read even though the type itself still shows up in
  // `types`. text/plain survives the same drag, so the payload rides along
  // there too and readMailDrag falls back to it.
  e.dataTransfer.setData('text/plain', json)
  e.dataTransfer.effectAllowed = 'move'
  setDragLabel(e, label)
}

export function readMailDrag(e: DragEvent): MailDrag | null {
  const raw = e.dataTransfer.getData(MAIL_DRAG) || e.dataTransfer.getData('text/plain')
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as MailDrag
    return Array.isArray(value.ids) && value.ids.length ? value : null
  } catch {
    return null
  }
}

export function setFolderDrag(e: DragEvent, mailboxId: string, label: string): void {
  e.dataTransfer.setData(FOLDER_DRAG, mailboxId)
  e.dataTransfer.effectAllowed = 'move'
  setDragLabel(e, label)
}

/*
 * Starting a native drag on touch is a long press, which is the same gesture
 * that opens the browser's own text-selection/context menu — without both of
 * these, dragging a row on a tablet also pops that menu on top of the drag.
 */
export const draggableTouchClass = 'select-none [-webkit-touch-callout:none]'
export function suppressContextMenu(e: MouseEvent): void {
  e.preventDefault()
}

/** What is being dragged, from the types alone — all a dragover may look at. */
export function dragKind(e: DragEvent): 'mail' | 'folder' | null {
  const types = e.dataTransfer.types
  if (types.includes(MAIL_DRAG)) return 'mail'
  if (types.includes(FOLDER_DRAG)) return 'folder'
  return null
}
