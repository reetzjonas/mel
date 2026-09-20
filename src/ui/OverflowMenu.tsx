import { useEffect, useRef, useState } from 'react'
import type { IconName } from './Icon'
import { Icon } from './Icon'
import { secondaryIconButtonClass } from './styles'
import { usePopover } from './usePopover'

export interface OverflowAction {
  label: string
  onSelect: () => void
  icon?: IconName
  disabled?: boolean
  pressed?: boolean
  danger?: boolean
}

/**
 * Compact actions that do not deserve permanent toolbar space.
 *
 * The trigger keeps its label for assistive technology while the opened menu
 * spells every action out. Arrow keys move between entries, and selecting an
 * item or pressing Escape returns focus to the trigger.
 */
export function OverflowMenu({ label, actions }: { label: string; actions: OverflowAction[] }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLSpanElement>(null)

  usePopover({ panel: root, onClose: () => setOpen(false), enabled: open })

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open])

  const close = () => {
    setOpen(false)
    requestAnimationFrame(() => trigger.current?.focus())
  }

  const moveFocus = (direction: 1 | -1) => {
    const items = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ]
    if (!items.length) return
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(at + direction + items.length) % items.length]?.focus()
  }

  return (
    <span ref={root} className="relative inline-flex">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
        className={secondaryIconButtonClass}
      >
        <Icon name="more" />
      </button>
      {open && (
        <span
          ref={menu}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              moveFocus(event.key === 'ArrowDown' ? 1 : -1)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close()
            }
          }}
          className="animate-rise absolute top-full right-0 z-30 mt-1 w-56 overflow-hidden rounded-control bg-raised py-1 shadow-overlay ring-1 ring-line"
        >
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role={action.pressed === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={action.pressed}
              disabled={action.disabled}
              onClick={() => {
                action.onSelect()
                close()
              }}
              className={`flex min-h-11 w-full items-center gap-2.5 px-3 text-left text-sm transition-colors hover:bg-surface-2 disabled:opacity-40 ${action.danger ? 'text-danger' : 'text-ink'}`}
            >
              {action.icon && <Icon name={action.icon} size={15} className="shrink-0" />}
              <span className="min-w-0 flex-1">{action.label}</span>
              {action.pressed && <Icon name="check" size={15} className="shrink-0 text-accent" />}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}
