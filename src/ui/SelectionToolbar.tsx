import type { ReactNode } from 'react'
import { t } from '../lib/i18n'
import { Icon, type IconName } from './Icon'
import { Tooltip } from './Tooltip'

/**
 * One bulk action inside a `SelectionToolbar` — icon-only with a tooltip,
 * generalized from Mail's local `ToolbarButton`. Icon-first and compact
 * rather than Files' old text-labeled buttons: the same convention scales
 * from Files' three actions to Mail's six without crowding the row.
 */
export function SelectionActionButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: IconName
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 sm:min-h-0 sm:min-w-0"
      >
        <Icon name={icon} size={15} />
      </button>
    </Tooltip>
  )
}

/**
 * The bar that replaces a list's ordinary header while a selection exists —
 * a clear button, a count, and whatever `SelectionActionButton`s the app
 * supplies. `onSelectAll` is optional: only Mail can answer "select
 * everything in this folder" server-side rather than only over what has
 * already loaded, so it's the one caller that passes it.
 */
export function SelectionToolbar({
  count,
  onClear,
  children,
  onSelectAll,
  selectAllLabel,
  busy,
}: {
  count: number
  onClear: () => void
  children: ReactNode
  onSelectAll?: () => void
  selectAllLabel?: string
  busy?: boolean
}) {
  return (
    <div className="px-2.5 pt-2.5 pb-1.5" data-testid="selection-toolbar">
      <div className="flex min-w-0 items-center gap-1">
        <Tooltip label={t('bulk.clear')}>
          <button
            type="button"
            aria-label={t('bulk.clear')}
            onClick={onClear}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink sm:min-h-0 sm:min-w-0"
          >
            <Icon name="close" size={15} />
          </button>
        </Tooltip>
        <span className="text-[13px] font-medium whitespace-nowrap">
          {count} {t('bulk.selected')}
        </span>
        <span className="ml-auto flex min-w-0 items-center overflow-x-auto">{children}</span>
      </div>
      {onSelectAll && (
        /*
         * Its own line: the actions above are the point of the bar and must
         * stay reachable, and this label is too long to share a narrow panel
         * with several icon buttons. Offered from the first tick onwards —
         * making someone tick every row by hand first defeats the shortcut.
         */
        <button
          type="button"
          onClick={onSelectAll}
          disabled={busy}
          className="mt-0.5 ml-8 block text-xs text-accent hover:underline disabled:opacity-40"
        >
          {selectAllLabel}
        </button>
      )}
    </div>
  )
}
