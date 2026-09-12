import { useEffect, useRef, useState, type RefObject } from 'react'
import { PANEL_LIMITS, PANEL_WIDTH_VAR, clampWidth, widthForKey, type Panel } from './panelWidths'

interface Props {
  panel: Panel
  /** Names the panel being resized, for the screen reader. */
  label: string
  width: number
  /** The element carrying the width, written to directly while dragging. */
  targetRef: RefObject<HTMLElement | null>
  onCommit: (width: number) => void
  onReset: () => void
}

/**
 * The grab area between two panels.
 *
 * Pointer events rather than mouse events, so a touch drag on a tablet wide
 * enough to show both panels works with the same code — and `touch-action:
 * none`, or that drag scrolls the page instead. Pointer capture keeps the
 * drag alive when the pointer outruns this four-pixel strip, which at speed
 * it always does.
 *
 * It is a real control, not a decoration: `role="separator"` with a value
 * makes it a window splitter, which screen readers announce with its current
 * width, and the arrow keys move it. That is not a fallback for the drag but
 * the only way to reach an exact width.
 */
export function ResizeHandle({ panel, label, width, targetRef, onCommit, onReset }: Props) {
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{
    startX: number
    startWidth: number
    available: number
    /** The last width previewed, which is what a cancel has to fall back on. */
    current: number
  } | null>(null)

  /** Room this panel shares with its neighbour, so a drag cannot swallow it. */
  const availableWidth = (el: HTMLElement | null) =>
    el?.parentElement?.getBoundingClientRect().width ?? 0

  /*
   * Written straight to the DOM while the drag is live. Going through React
   * would re-render the message list on every pointer move, and that list is
   * virtualised precisely because it can hold tens of thousands of rows.
   */
  const preview = (next: number) => {
    targetRef.current?.style.setProperty(PANEL_WIDTH_VAR, `${next}px`)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Secondary buttons open menus; they are not a drag.
    if (e.button !== 0) return
    /*
     * Claims the gesture. Without this Chrome starts a text selection on the
     * first move and abandons the pointer sequence with `pointercancel` —
     * measured: exactly one pointermove arrives, then a cancel.
     */
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = {
      startX: e.clientX,
      startWidth: width,
      available: availableWidth(targetRef.current),
      current: width,
    }
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    d.current = clampWidth(panel, d.startWidth + (e.clientX - d.startX), d.available)
    preview(d.current)
  }

  /*
   * Keeps whatever was last shown, rather than recomputing from the event.
   *
   * A `pointercancel` carries no meaningful position — Chrome reports
   * clientX 0 — and recomputing from it committed a width of *negative* 254,
   * which clamped to the minimum. The panel collapsed the moment the gesture
   * was interrupted. What was on screen at the time is the only honest answer.
   */
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    setDragging(false)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    onCommit(d.current)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const next = widthForKey(panel, width, e.key, e.shiftKey, availableWidth(targetRef.current))
    if (next === null) return
    // Only once a key is ours: the handle is in the tab order, and swallowing
    // Tab or Enter would trap the focus on it.
    e.preventDefault()
    onCommit(next)
  }

  /*
   * The cursor belongs to the whole document while dragging, not to the four
   * pixels under it — without this it flickers back to a text caret the
   * moment the pointer leaves the strip, which it does immediately.
   */
  useEffect(() => {
    if (!dragging) return
    const previous = document.body.style.cursor
    document.body.style.cursor = 'col-resize'
    document.body.classList.add('select-none')
    return () => {
      document.body.style.cursor = previous
      document.body.classList.remove('select-none')
    }
  }, [dragging])

  const { min, max } = PANEL_LIMITS[panel]

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      /*
       * As wide as the gutter it sits in, with negative margins cancelling
       * the two flex gaps it would otherwise earn: 12 - 12 + 12 - 12 + 12 =
       * 12, exactly what the gap between the panels cost before. The handle
       * covers the gutter rather than adding to it.
       *
       * A real width rather than zero plus an overflowing child: a control
       * with no bounding box is one that hit-testing, assistive technology
       * and Playwright all struggle to find, however well the pointer events
       * happen to bubble.
       *
       * That is not tidiness. A four-pixel strip plus its own gap took 16px
       * per boundary, 32px across both, and the reading pane's action labels
       * hang off a container query at 768px — at a 1440px window that pushed
       * it under the threshold and the buttons silently went back to icons.
       * Caught by mail.spec.ts, which measures exactly that.
       *
       * Hidden below lg, where the panels take turns and there is no boundary.
       */
      className="group relative -mx-3 hidden w-3 shrink-0 cursor-col-resize touch-none self-stretch focus:outline-none lg:block"
    >
      {/* The thin line actually drawn, centred in the gutter. */}
      <span
        aria-hidden
        className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors ${
          dragging
            ? 'bg-accent'
            : 'bg-transparent group-hover:bg-border group-focus-visible:bg-accent'
        }`}
      />
    </div>
  )
}
