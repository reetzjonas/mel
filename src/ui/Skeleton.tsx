/** Shimmering placeholder used while the first sync fills the list. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`block animate-[mel-shimmer_1.4s_linear_infinite] rounded bg-[length:200%_100%] bg-[linear-gradient(90deg,var(--color-surface-2)_25%,var(--color-line)_37%,var(--color-surface-2)_63%)] ${className}`}
    />
  )
}

export interface RowSkeletonProps {
  /** A leading shape before the text — omit for a row with no icon/avatar
   *  (Notes' rows are title-only, so they pass none). */
  avatar?: 'circle' | 'square'
  /** Text lines below the header line — Mail has two (subject, preview),
   *  Contacts and Files have one (email, size/type), Notes has none. */
  lines?: 0 | 1 | 2
  /** A short trailing mark beside the header line — Mail's date. */
  meta?: boolean
}

/** One list row's placeholder, shaped to match whichever app renders it. */
export function RowSkeleton({ avatar, lines = 1, meta = false }: RowSkeletonProps) {
  return (
    <div className="flex gap-3 px-3 py-2.5">
      {avatar && (
        <Skeleton
          className={`h-9 w-9 shrink-0 ${avatar === 'circle' ? 'rounded-full' : 'rounded-control'}`}
        />
      )}
      <div className="min-w-0 flex-1 space-y-1.5 py-0.5">
        <div className="flex justify-between gap-3">
          <Skeleton className="h-3 w-28" />
          {meta && <Skeleton className="h-3 w-10" />}
        </div>
        {lines >= 1 && <Skeleton className="h-3 w-3/5" />}
        {lines >= 2 && <Skeleton className="h-2.5 w-4/5" />}
      </div>
    </div>
  )
}

/** A column of `RowSkeleton`s, for a list still waiting on its first read. */
export function ListSkeleton({ rows = 7, ...row }: { rows?: number } & RowSkeletonProps) {
  return (
    <div className="animate-fade">
      {Array.from({ length: rows }, (_, i) => (
        <RowSkeleton key={i} {...row} />
      ))}
    </div>
  )
}
