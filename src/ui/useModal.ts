import { useEffect, useEffectEvent, useState, type RefObject } from 'react'

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Keyboard behaviour shared by the app's modal surfaces. */
export function useModal({
  panel,
  initialFocus,
  onClose,
  enabled = true,
}: {
  panel: RefObject<HTMLElement | null>
  initialFocus?: RefObject<HTMLElement | null>
  onClose: () => void
  enabled?: boolean
}) {
  const close = useEffectEvent(onClose)
  useEffect(() => {
    if (!enabled) return
    const opener = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => (initialFocus?.current ?? panel.current)?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab' || !panel.current) return
      const targets = [...panel.current.querySelectorAll<HTMLElement>(focusable)]
      if (targets.length === 0) {
        event.preventDefault()
        return
      }
      const first = targets[0]!
      const last = targets.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      opener?.focus?.()
    }
  }, [enabled, initialFocus, panel])
}

/** The usable height and keyboard inset of a narrow visual viewport. */
export function useMobileViewport() {
  const [viewport, setViewport] = useState<{ height: number; inset: number } | null>(null)

  useEffect(() => {
    const visualViewport = window.visualViewport
    if (!visualViewport) return
    const update = () => {
      if (visualViewport.width >= 640) return setViewport(null)
      setViewport({
        height: visualViewport.height,
        inset: Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop),
      })
    }
    update()
    visualViewport.addEventListener('resize', update)
    visualViewport.addEventListener('scroll', update)
    return () => {
      visualViewport.removeEventListener('resize', update)
      visualViewport.removeEventListener('scroll', update)
    }
  }, [])

  return viewport
}
