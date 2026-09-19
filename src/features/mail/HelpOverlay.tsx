import { useRef } from 'react'
import { useUi } from '../../app/store'
import { t } from '../../lib/i18n'
import { modalPanelClass } from '../../ui/styles'
import { useModal } from '../../ui/useModal'
import { DialogHeader } from '../../ui/DialogHeader'

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
  return <HelpDialog onClose={() => setHelpOpen(false)} />
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  useModal({ panel, onClose })
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal
        aria-label={t('shortcuts.title')}
        className={`${modalPanelClass} max-w-sm p-5 max-sm:rounded-t-panel`}
      >
        <DialogHeader
          title={t('shortcuts.title')}
          closeLabel={t('shortcuts.close')}
          onClose={onClose}
        />
        <dl className="space-y-1.5 p-5">
          {rows.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between text-sm">
              <dt>
                <kbd className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-xs ring-1 ring-line">
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
