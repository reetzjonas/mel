import { useUi } from '../app/store'

export function Snackbar() {
  const { snackbar, hideSnackbar } = useUi()
  if (!snackbar) return null
  return (
    <div className="fixed bottom-16 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-ink px-4 py-2 text-sm text-bg shadow-lg sm:bottom-6">
      <span>{snackbar.message}</span>
      {snackbar.action && snackbar.actionLabel && (
        <button
          type="button"
          className="font-semibold text-accent uppercase"
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
