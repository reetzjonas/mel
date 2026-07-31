/** Shimmering placeholder used while the first sync fills the list. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`block animate-[mel-shimmer_1.4s_linear_infinite] rounded bg-[length:200%_100%] bg-[linear-gradient(90deg,var(--color-surface-2)_25%,var(--color-line)_37%,var(--color-surface-2)_63%)] ${className}`}
    />
  )
}

/** Mail list placeholder that mirrors the real row's rhythm. */
export function ThreadRowSkeleton() {
  return (
    <div className="flex gap-3 px-3 py-2.5">
      <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-1.5 py-0.5">
        <div className="flex justify-between gap-3">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-10" />
        </div>
        <Skeleton className="h-3 w-3/5" />
        <Skeleton className="h-2.5 w-4/5" />
      </div>
    </div>
  )
}

export function ThreadListSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div className="animate-fade">
      {Array.from({ length: rows }, (_, i) => (
        <ThreadRowSkeleton key={i} />
      ))}
    </div>
  )
}
