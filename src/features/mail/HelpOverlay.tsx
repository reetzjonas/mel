import { useUi } from '../../app/store'
import { t } from '../../lib/i18n'

const rows: Array<[string, Parameters<typeof t>[0]]> = [
  ['j / k', 'shortcuts.jk'],
  ['e', 'shortcuts.e'],
  ['#', 'shortcuts.del'],
  ['s', 'shortcuts.s'],
  ['u', 'shortcuts.u'],
  ['r', 'shortcuts.r'],
  ['a', 'shortcuts.a'],
  ['f', 'shortcuts.f'],
  ['c', 'shortcuts.c'],
  ['/', 'shortcuts.slash'],
  ['g i', 'shortcuts.gi'],
  ['?', 'shortcuts.help'],
]

export function HelpOverlay() {
  const { helpOpen, setHelpOpen } = useUi()
  if (!helpOpen) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={() => setHelpOpen(false)}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{t('shortcuts.title')}</h2>
          <button
            type="button"
            className="text-sm text-ink-muted hover:text-ink"
            onClick={() => setHelpOpen(false)}
          >
            {t('shortcuts.close')}
          </button>
        </div>
        <dl className="space-y-1.5">
          {rows.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between text-sm">
              <dt>
                <kbd className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
                  {key}
                </kbd>
              </dt>
              <dd className="text-ink-muted">{t(label)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
