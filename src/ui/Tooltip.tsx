import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'

/**
 * The native `title` attribute waits about a second and is drawn by the OS, so
 * it never matches the app. This is the same idea on the app's own surfaces,
 * and quick enough to feel like a label rather than a delayed reveal.
 */
const OPEN_DELAY_MS = 120
/** Distance between the control and the bubble. */
const GAP = 6
/** Keeps the bubble off the viewport edge when a control sits near one. */
const MARGIN = 8

interface Position {
  x: number
  /** Anchored by its bottom when above the control, by its top when below. */
  y: number
  below: boolean
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value)
  else if (ref) (ref as { current: T | null }).current = value
}

/**
 * cloneElement replaces the child's own ref, so it has to be re-applied by
 * hand or whoever set it silently stops receiving the node.
 */
function childRefOf(el: ReactElement): Ref<HTMLElement> | undefined {
  return (el as { props?: { ref?: Ref<HTMLElement> } }).props?.ref
}

/**
 * Wraps a single control and labels it on hover or keyboard focus.
 *
 * The child keeps whatever accessible name it already has — the bubble is
 * `aria-hidden`, so a screen reader is not told the same word twice.
 */
export function Tooltip({ label, children }: { label: string; children: ReactElement }) {
  const [pos, setPos] = useState<Position | null>(null)
  const anchor = useRef<HTMLElement | null>(null)
  const bubble = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const close = useCallback(() => {
    clearTimeout(timer.current)
    setPos(null)
  }, [])

  const open = useCallback(() => {
    // Touch has no hover: the synthesised mouseenter would leave a bubble
    // sitting on screen after a tap with nothing to dismiss it.
    if (!window.matchMedia('(hover: hover)').matches) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const el = anchor.current
      if (!el) return
      const r = el.getBoundingClientRect()
      // Above unless the control is too close to the top to fit there.
      const below = r.top < 40
      setPos({
        x: r.left + r.width / 2,
        y: below ? r.bottom + GAP : window.innerHeight - r.top + GAP,
        below,
      })
    }, OPEN_DELAY_MS)
  }, [])

  // Anything that moves the control out from under the bubble closes it —
  // otherwise it hangs over unrelated content.
  useEffect(() => {
    if (!pos) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [pos, close])

  useEffect(() => () => clearTimeout(timer.current), [])

  // Centring is done with a transform, so the bubble's own width is only known
  // once it is in the DOM — clamp it off the viewport edges afterwards.
  useLayoutEffect(() => {
    const el = bubble.current
    if (!el || !pos) return
    const width = el.offsetWidth
    const clamped = Math.min(
      Math.max(pos.x, MARGIN + width / 2),
      window.innerWidth - MARGIN - width / 2,
    )
    if (clamped !== pos.x) setPos({ ...pos, x: clamped })
  }, [pos])

  return (
    <>
      {cloneElement(children as ReactElement<Record<string, unknown>>, {
        ref: (node: HTMLElement | null) => {
          anchor.current = node
          setRef(childRefOf(children), node)
        },
        onMouseEnter: open,
        onMouseLeave: close,
        // A click has done what the label promised; leaving it up is noise.
        onPointerDown: close,
        onFocus: (e: React.FocusEvent<HTMLElement>) => {
          if (e.target.matches(':focus-visible')) open()
        },
        onBlur: close,
      })}
      {pos &&
        createPortal(
          <div
            ref={bubble}
            role="presentation"
            aria-hidden
            data-testid="tooltip"
            style={{
              left: pos.x,
              ...(pos.below ? { top: pos.y } : { bottom: pos.y }),
            }}
            // pre-line, not nowrap: some labels carry their own line breaks
            // (the sync bar lists several facts) and must not run off-screen.
            className="animate-fade pointer-events-none fixed z-50 max-w-64 -translate-x-1/2 rounded-control bg-raised px-2 py-1 text-[11px] whitespace-pre-line text-ink shadow-overlay ring-1 ring-line"
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  )
}
