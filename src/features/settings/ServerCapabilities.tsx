import type { Account } from '../../domain/account'
import { t } from '../../lib/i18n'
import { Icon } from '../../ui/Icon'
import { capabilityRows, type CapabilityState } from './capabilities'

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
    </div>
  )
}
