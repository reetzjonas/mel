import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResizeHandle } from './ResizeHandle'
import { PANEL_LIMITS, PANEL_WIDTH_VAR } from './panelWidths'

/*
 * The width arithmetic is covered in panelWidths.test.ts. What is only
 * visible here is how the handle spends it: which changes reach the DOM
 * directly, which reach React, and what the thing announces itself as.
 */

const onCommit = vi.fn()
const onReset = vi.fn()

/** Renders the handle beside a panel, the way the routes do. */
function Harness({ width = 384 }: { width?: number }) {
  const target = useRef<HTMLElement | null>(null)
  return (
    <div style={{ width: 1600 }}>
      <section
        ref={target}
        data-testid="panel"
        style={{ [PANEL_WIDTH_VAR]: `${width}px` } as React.CSSProperties}
      />
      <ResizeHandle
        panel="list"
        label="Message list width"
        width={width}
        targetRef={target}
        onCommit={onCommit}
        onReset={onReset}
      />
    </div>
  )
}

const handle = () => screen.getByRole('separator')
const panelWidth = () => screen.getByTestId('panel').style.getPropertyValue(PANEL_WIDTH_VAR)

beforeEach(() => {
  vi.clearAllMocks()
  // jsdom has no pointer capture; the handle asks for it on every drag.
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  render(<Harness />)
})

// This project runs vitest without globals, so nothing unmounts between tests
// on its own — and two handles in the document make every query ambiguous.
afterEach(cleanup)

describe('dragging the boundary', () => {
  it('previews through the DOM and only tells React on release', async () => {
    /*
     * The message list is virtualised because it can hold tens of thousands
     * of rows. Committing a width on every pointer move would re-render it
     * per pixel — so the drag writes the custom property straight to the
     * element, and React hears about it once.
     */
    fireEvent.pointerDown(handle(), { button: 0, clientX: 500, pointerId: 1 })
    fireEvent.pointerMove(handle(), { clientX: 560, pointerId: 1 })
    fireEvent.pointerMove(handle(), { clientX: 600, pointerId: 1 })

    expect(panelWidth()).toBe('484px')
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.pointerUp(handle(), { clientX: 600, pointerId: 1 })

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(484)
  })

  it('ignores a move that no drag started', () => {
    // Pointer capture is not in play until pointerdown, and a stray move over
    // the strip must not resize anything.
    fireEvent.pointerMove(handle(), { clientX: 900, pointerId: 1 })

    expect(panelWidth()).toBe('384px')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not start on a secondary button, which is asking for a menu', () => {
    fireEvent.pointerDown(handle(), { button: 2, clientX: 500, pointerId: 1 })
    fireEvent.pointerMove(handle(), { clientX: 900, pointerId: 1 })

    expect(panelWidth()).toBe('384px')
  })

  it('keeps the width it was showing when the gesture is cancelled', () => {
    /*
     * A cancel carries no position — Chrome reports clientX 0 — so the width
     * has to come from what was last previewed, not from the event.
     *
     * This test first asserted the opposite, because it handed the cancel a
     * plausible clientX that no browser sends. Against a real one the panel
     * collapsed: 384 + (0 - 500) is -116, which clamps to the minimum, so an
     * interrupted drag shrank the list as far as it would go. The zero here
     * is what the browser actually delivers.
     */
    fireEvent.pointerDown(handle(), { button: 0, clientX: 500, pointerId: 1 })
    fireEvent.pointerMove(handle(), { clientX: 540, pointerId: 1 })
    fireEvent.pointerCancel(handle(), { clientX: 0, pointerId: 1 })

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(424)
  })

  it('claims the gesture, or the browser turns it into a text selection', () => {
    /*
     * Measured, not guessed: without preventDefault on pointerdown Chrome
     * begins selecting text on the first move and abandons the pointer
     * sequence — exactly one pointermove arrives, then a pointercancel.
     */
    const down = new Event('pointerdown', { bubbles: true, cancelable: true })
    Object.assign(down, { button: 0, clientX: 500, pointerId: 1 })
    handle().dispatchEvent(down)

    expect(down.defaultPrevented).toBe(true)
  })

  it('stops at the limits rather than dragging past them', () => {
    fireEvent.pointerDown(handle(), { button: 0, clientX: 500, pointerId: 1 })
    fireEvent.pointerMove(handle(), { clientX: -5000, pointerId: 1 })

    expect(panelWidth()).toBe(`${PANEL_LIMITS.list.min}px`)
  })
})

describe('resizing without a pointer', () => {
  it('announces itself as a splitter with a width', () => {
    /*
     * role="separator" plus a value is the window-splitter pattern: a screen
     * reader then reads out the current width and offers the arrow keys,
     * rather than describing an unlabelled div.
     */
    expect(handle()).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle()).toHaveAccessibleName('Message list width')
    expect(handle()).toHaveAttribute('aria-valuenow', '384')
    expect(handle()).toHaveAttribute('aria-valuemin', String(PANEL_LIMITS.list.min))
    expect(handle()).toHaveAttribute('aria-valuemax', String(PANEL_LIMITS.list.max))
    expect(handle()).toHaveAttribute('tabindex', '0')
  })

  it('commits each arrow press at once, since there is nothing to release', () => {
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    expect(onCommit).toHaveBeenCalledWith(400)

    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    expect(onCommit).toHaveBeenLastCalledWith(368)
  })

  it('leaves keys that are not its own to the browser', () => {
    /*
     * The handle sits in the tab order. Swallowing Tab would trap the focus
     * on a four-pixel strip with no way out, which is worse than not being
     * reachable at all.
     */
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    handle().dispatchEvent(tab)

    expect(tab.defaultPrevented).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('goes back to the shipped width on a double click', () => {
    // The affordance for "I have made a mess of this" — and the only one that
    // also stops the width being remembered at all.
    fireEvent.doubleClick(handle())

    expect(onReset).toHaveBeenCalledOnce()
  })
})
