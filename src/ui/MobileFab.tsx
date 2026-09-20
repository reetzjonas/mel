import type { IconName } from './Icon'
import { Icon } from './Icon'

/** The compact layout's single, thumb-reachable primary creation action. */
export function MobileFab({
  icon,
  label,
  onClick,
  disabled,
  until = 'sm',
}: {
  icon: IconName
  label: string
  onClick: () => void
  disabled?: boolean
  /** Mail stays single-pane through the medium layout, unlike the other apps. */
  until?: 'sm' | 'lg'
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`animate-rise fixed right-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-accent-ink shadow-overlay transition-transform duration-150 active:scale-95 disabled:opacity-50 sm:bottom-4 ${until === 'lg' ? 'lg:hidden' : 'sm:hidden'}`}
    >
      <Icon name={icon} size={22} />
    </button>
  )
}
