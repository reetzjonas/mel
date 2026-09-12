import { useState } from 'react'
import type { Account } from '../../domain/account'
import { t, type MsgKey } from '../../lib/i18n'
import { refreshCapabilities } from '../../services/accounts'
import { Icon } from '../../ui/Icon'
import { secondaryButtonClass } from '../../ui/styles'
import { capabilityRows, type CapabilityState } from './capabilities'
import { useSettingsRoute } from './navigation'

/**
 * What a screen shows instead of a feature this server does not offer.
 *
 * Always with the way to the full list: "no calendar here" invites the
 * question of what else is missing, and the answer is one screen away.
 */
export function CapabilityNotice({ reason }: { reason: MsgKey }) {
  const { open: openSettings } = useSettingsRoute()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-muted">
      <p className="text-sm">{t(reason)}</p>
      <button
        type="button"
        onClick={() => openSettings('account')}
        className="text-sm text-accent hover:underline"
      >
        {t('caps.showDetails')}
      </button>
    </div>
  )
}

function StateMark({ state }: { state: CapabilityState }) {
  // Value rows (the transport) have nothing to tick; an empty column keeps the
  // labels aligned without inventing a mark that means nothing.
  if (state === 'info') return null
  return state === 'yes' ? (
    <Icon name="check" size={13} className="text-success" />
  ) : (
    <Icon name="close" size={13} className="text-ink-subtle" />
  )
}

/**
 * What this server offers, and what each answer changes in the app.
 *
 * Reached from the sync status in the sidebar and from the screens that a
 * missing capability blocks, because that is where the question comes up.
 */
export function ServerCapabilities({ account }: { account: Account }) {
  const rows = capabilityRows(account.capabilities)
  /*
   * The list itself needs no state — it re-renders from the stored account
   * as soon as the refresh writes one, through the same live query the rest
   * of the app reads. Only the button's own progress lives here, and "done"
   * has to be said out loud: a server that changed nothing produces a
   * refresh that looks exactly like one that never ran.
   */
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')

  return (
    <div className="space-y-2" id="server-capabilities">
      <p className="text-xs text-ink-subtle">{account.sessionUrl}</p>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.id} className="text-sm">
            <span className="flex items-center gap-2">
              <span className="flex w-4 shrink-0 justify-center">
                <StateMark state={row.state} />
              </span>
              <span className="min-w-0 flex-1 truncate">{t(row.label)}</span>
              <span className="shrink-0 text-xs text-ink-muted">
                {row.value ? t(row.value) : t(row.state === 'yes' ? 'caps.yes' : 'caps.no')}
              </span>
            </span>
            {row.gate && (
              <span className="mt-0.5 block pl-6 text-xs text-ink-subtle">{t(row.gate)}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          disabled={state === 'busy'}
          className={secondaryButtonClass}
          onClick={() => {
            setState('busy')
            void refreshCapabilities(account.id).then(
              () => setState('done'),
              () => setState('failed'),
            )
          }}
        >
          {state === 'busy' ? t('caps.reload.running') : t('caps.reload')}
        </button>
        {state === 'done' && (
          <span className="text-xs text-ink-muted">{t('caps.reload.done')}</span>
        )}
        {state === 'failed' && (
          <span className="text-xs text-danger">{t('caps.reload.failed')}</span>
        )}
      </div>
    </div>
  )
}
