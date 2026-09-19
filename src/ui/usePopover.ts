import { useEffect, useEffectEvent, useLayoutEffect, useState, type RefObject } from 'react'

/** Whether the narrow layout is active, including when the viewport changes. */
export function useMobileLayout() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 639px)').matches)

  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)')
    const update = () => setMobile(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return mobile
}

/** Dismisses a non-modal popover when its contents and optional anchor lose the click. */
export function usePopover({
  panel,
  anchor,
  onClose,
  enabled = true,
}: {
  panel: RefObject<HTMLElement | null>
  anchor?: HTMLElement | null
  onClose: () => void
  enabled?: boolean
}) {
  const close = useEffectEvent(onClose)

  useEffect(() => {
    if (!enabled) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node
      if (panel.current?.contains(target) || anchor?.contains(target)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor, enabled, panel])
}

/** A fixed popover position aligned with the lower-right corner of its anchor. */
export function usePopoverPosition(anchor: HTMLElement | null, width = 320) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!anchor) return
    const update = () => {
      const rect = anchor.getBoundingClientRect()
      setPosition({
        top: rect.bottom + 4,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor, width])

  return position
}
