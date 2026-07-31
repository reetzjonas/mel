import { useUi } from '../app/store'

export function Snackbar() {
  const { snackbar, hideSnackbar } = useUi()
  if (!snackbar) return null
  return (
    <div
      role="status"
      className="animate-rise fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-ink py-2.5 pr-2.5 pl-4 text-sm text-canvas shadow-overlay sm:bottom-6"
    >
      <span>{snackbar.message}</span>
      {snackbar.action && snackbar.actionLabel && (
        <button
          type="button"
          className="rounded-full px-3 py-1 text-xs font-semibold tracking-wide text-canvas uppercase transition-colors hover:bg-canvas/15"
          onClick={() => {
            snackbar.action?.()
            hideSnackbar()
          }}
        >
          {snackbar.actionLabel}
        </button>
      )}
    </div>
  )
}
