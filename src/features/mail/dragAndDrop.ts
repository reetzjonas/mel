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
  /*
   * Sized and outlined to stay legible under a fingertip on touch, which a
   * thumbnail-sized, borderless label was not: a fingertip covers far more of
   * the screen than a mouse pointer does, so the label has to hold its own a
   * short distance away rather than blend into whatever is under it.
   *
   * A `border`, not a `ring`, and no shadow. setDragImage takes a snapshot
   * that clips at the border box, and Tailwind's ring is a box-shadow *outside*
   * it: the straight edges were cut away entirely while the rounded corners
   * still caught a fragment, so the label dragged around four violet corner
   * brackets and no frame. A border is part of the box and survives the
   * snapshot; `shadow-raised` was being clipped just the same and did nothing
   * here but cost a repaint.
   */
  el.className =
    'pointer-events-none fixed top-0 left-0 max-w-[220px] truncate rounded-control border-2 border-accent bg-surface-2 px-3.5 py-2.5 text-[15px] font-medium text-ink'
  // Off-screen but still rendered, which is all setDragImage needs.
  el.style.transform = 'translate(-9999px, -9999px)'
  document.body.appendChild(el)
  // A negative hotspot places the image's top-left *past* the cursor, i.e.
  // down and to the right of it — the trailing side when dragging from the
  // mail list or a folder row towards the sidebar above and to the left.
  e.dataTransfer.setDragImage(el, -16, -16)
  setTimeout(() => el.remove(), 0)
}

/*
 * A touch-started drag cannot be trusted to carry either of these through
 * `dataTransfer`: on tablet, `dragover` can see an empty `types` list (no way
 * to tell mail from folder, so a folder never highlights and a drop never
 * fires — the bug this fixes), and even where `types` does come through,
 * `getData` on drop is not guaranteed to return what was set. dragstart
 * itself is reliable on touch, so both the kind and the mail payload are
 * kept here instead, the same way the folder side already keeps the folder
 * being dragged in its own component state rather than round-tripping it
 * through `dataTransfer`. `dataTransfer` still gets the MIME type set, since
 * that is the one thing this module cannot fabricate for a *foreign* drag —
 * dragging something from outside the app must keep reading as "nothing" —
 * and it is tried first in `dragKind` so nothing changes on the engines
 * where `types` was already reliable during dragover.
 */
let liveDragKind: 'mail' | 'folder' | null = null
let mailPayload: MailDrag | null = null

export function setMailDrag(e: DragEvent, payload: MailDrag, label: string): void {
  liveDragKind = 'mail'
  mailPayload = payload
  e.dataTransfer.setData(MAIL_DRAG, '1')
  e.dataTransfer.effectAllowed = 'move'
  setDragLabel(e, label)
}

export function readMailDrag(e: DragEvent): MailDrag | null {
  return dragKind(e) === 'mail' ? mailPayload : null
}

export function setFolderDrag(e: DragEvent, mailboxId: string, label: string): void {
  liveDragKind = 'folder'
  e.dataTransfer.setData(FOLDER_DRAG, mailboxId)
  e.dataTransfer.effectAllowed = 'move'
  setDragLabel(e, label)
}

/** Call on every dragend, so a later foreign drag cannot read as a stale one. */
export function clearDragState(): void {
  liveDragKind = null
  mailPayload = null
}

/*
 * Starting a native drag on touch is a long press, which is the same gesture
 * that opens the browser's own text-selection/context menu — without both of
 * these, dragging a row on a tablet also pops that menu on top of the drag.
 *
 * Only ever applied to plain elements (a mail row, a draggable folder row),
 * never to a real `<a>`: WebKit's own long-press handling of links and
 * images runs outside the page's drag-and-drop entirely and a touch drag
 * started from one never reaches other elements' `dragover` — no CSS switch
 * talks it out of that, so a draggable folder is a `div` with its own
 * navigation instead of a `Link`. See docs/notes/drag-and-drop.md.
 */
export const draggableTouchClass = 'select-none [-webkit-touch-callout:none]'
export function suppressContextMenu(e: MouseEvent): void {
  e.preventDefault()
}

/** What is being dragged. `types` first; `liveDragKind` for when it comes up empty. */
export function dragKind(e: DragEvent): 'mail' | 'folder' | null {
  const types = e.dataTransfer.types
  if (types.includes(MAIL_DRAG)) return 'mail'
  if (types.includes(FOLDER_DRAG)) return 'folder'
  return types.length === 0 ? liveDragKind : null
}
