import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DragEvent } from 'react'
import {
  clearDragState,
  dragKind,
  readMailDrag,
  setFolderDrag,
  setMailDrag,
  suppressContextMenu,
  FOLDER_DRAG,
  MAIL_DRAG,
} from './dragAndDrop'

/**
 * A drag event with a DataTransfer that behaves like the browser's: `types`
 * lists what has been set, and setDragImage is recorded rather than drawn.
 */
function dragEvent(types: string[] = []) {
  const data = new Map<string, string>()
  for (const t of types) data.set(t, '1')
  return {
    dataTransfer: {
      get types() {
        return [...data.keys()]
      },
      setData: (type: string, value: string) => void data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      setDragImage: vi.fn(),
      effectAllowed: 'none',
    },
  } as unknown as DragEvent
}

/**
 * A touch-started drag on tablet: the browser reports no types at all during
 * dragover, which is what broke every drop target until the kind was kept
 * outside dataTransfer.
 */
const touchDrag = () => dragEvent([])

const payload = { mailboxId: 'inbox', ids: ['m1', 'm2'] }

beforeEach(() => clearDragState())
afterEach(() => clearDragState())

describe('telling what is being dragged', () => {
  it('reads the kind off the MIME type when the browser reports one', () => {
    expect(dragKind(dragEvent([MAIL_DRAG]))).toBe('mail')
    expect(dragKind(dragEvent([FOLDER_DRAG]))).toBe('folder')
  })

  it('falls back to what dragstart recorded when types comes up empty', () => {
    // The tablet case. dragstart is reliable there; `types` during dragover
    // is not, and without this no folder ever highlighted.
    setMailDrag(dragEvent(), payload, 'Subject')
    expect(dragKind(touchDrag())).toBe('mail')

    setFolderDrag(dragEvent(), 'mb-1', 'Rechnungen')
    expect(dragKind(touchDrag())).toBe('folder')
  })

  it('still reads a drag from outside the app as nothing', () => {
    // The fallback must not turn every foreign drag into one of ours: a file
    // dragged in from the desktop would otherwise look like mail.
    expect(dragKind(dragEvent(['Files']))).toBeNull()
    expect(dragKind(dragEvent(['text/plain']))).toBeNull()
    // Empty types with nothing recorded is a foreign drag too.
    expect(dragKind(touchDrag())).toBeNull()
  })

  it('stops answering for a finished drag', () => {
    // dragend clears it, so the next foreign drag cannot inherit the kind of
    // the last one of ours.
    setMailDrag(dragEvent(), payload, 'Subject')
    clearDragState()
    expect(dragKind(touchDrag())).toBeNull()
  })
})

describe('the mail a drag is carrying', () => {
  it('comes back whole, without a round trip through dataTransfer', () => {
    // getData on a touch-started drag is not dependable either, so the
    // payload never goes through it.
    setMailDrag(dragEvent(), payload, 'Subject')
    expect(readMailDrag(touchDrag())).toEqual(payload)
  })

  it('is refused to a drag that is not mail', () => {
    setFolderDrag(dragEvent(), 'mb-1', 'Rechnungen')
    expect(readMailDrag(touchDrag())).toBeNull()
    expect(readMailDrag(dragEvent([FOLDER_DRAG]))).toBeNull()
  })

  it('is gone once the drag has ended', () => {
    /*
     * Read order matters and got this wrong once: the drop handler cleared
     * the state before reading it, so on touch — where the recorded kind is
     * what readMailDrag needs — the payload was already gone and the move
     * silently did not happen.
     */
    setMailDrag(dragEvent(), payload, 'Subject')
    clearDragState()
    expect(readMailDrag(touchDrag())).toBeNull()
  })

  it('sets the MIME type as well, so a drop target can refuse in advance', () => {
    // The target may only look at `types` while the drag is in flight; the
    // value is a placeholder, since the payload is kept here.
    const e = dragEvent()
    setMailDrag(e, payload, 'Subject')
    expect(e.dataTransfer.types).toContain(MAIL_DRAG)
    expect(e.dataTransfer.effectAllowed).toBe('move')
  })

  it('replaces the previous drag rather than adding to it', () => {
    setMailDrag(dragEvent(), payload, 'First')
    setMailDrag(dragEvent(), { mailboxId: 'archive', ids: ['m9'] }, 'Second')
    expect(readMailDrag(touchDrag())).toEqual({ mailboxId: 'archive', ids: ['m9'] })
  })
})

describe('the drag image', () => {
  it('is a small label rather than the browser default', () => {
    /*
     * The default is a snapshot of the row, which for a mail row is wide
     * enough to cover the sidebar it has to be dropped on — you cannot see
     * the folder you are aiming at.
     */
    const e = dragEvent()
    setMailDrag(e, payload, 'Rechnung März')
    const [node, x, y] = (e.dataTransfer.setDragImage as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [HTMLElement, number, number]

    expect(node.textContent).toBe('Rechnung März')
    // A negative hotspot puts the label past the cursor, on the trailing
    // side, so the drop target beside the pointer stays visible.
    expect(x).toBeLessThan(0)
    expect(y).toBeLessThan(0)
  })

  it('is in the document to be snapshotted, and gone a tick later', async () => {
    // Both halves matter: the browser can only snapshot a node that is
    // rendered, and a label left behind would pile up one per drag.
    await new Promise((r) => setTimeout(r, 0))
    const before = document.body.childElementCount

    setMailDrag(dragEvent(), payload, 'Subject')
    expect(document.body.childElementCount).toBe(before + 1)

    await new Promise((r) => setTimeout(r, 0))
    expect(document.body.childElementCount).toBe(before)
  })
})

describe('suppressContextMenu', () => {
  it('stops the browser menu that a long press would open alongside the drag', () => {
    const preventDefault = vi.fn()
    suppressContextMenu({ preventDefault } as unknown as Parameters<typeof suppressContextMenu>[0])
    expect(preventDefault).toHaveBeenCalled()
  })
})
