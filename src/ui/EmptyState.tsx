import { Icon, type IconName } from './Icon'

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: IconName
  title: string
  hint?: string
}) {
  return (
    <div className="animate-fade flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-ink-subtle">
        <Icon name={icon} size={24} />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium text-ink-muted">{title}</p>
        {hint && <p className="max-w-56 text-xs text-ink-subtle">{hint}</p>}
      </div>
    </div>
  )
}
