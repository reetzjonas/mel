import type { AccountCapabilities } from '../../domain/account'
import type { MsgKey } from '../../lib/i18n'

export type CapabilityState = 'yes' | 'no' | 'info'

export interface CapabilityRow {
  id: string
  label: MsgKey
  state: CapabilityState
  /** For rows that report a value rather than yes/no. */
  value?: MsgKey
  /**
   * What the user can actually observe as a result. This is the point of the
   * whole section: a hidden feature is invisible by definition, so the flag on
   * its own explains nothing.
   */
  gate?: MsgKey
}

/**
 * Pair every server capability with the effect it has on this UI.
 *
 * Every line here is a promise about what the app actually does, so a gate
 * that changes has to change here in the same breath: `mail` and `submission`
 * both used to say "nothing is hidden for this" and had to be rewritten the
 * day they started hiding things.
 */
export function capabilityRows(caps: AccountCapabilities): CapabilityRow[] {
  return [
    {
      id: 'mail',
      label: 'caps.mail',
      state: caps.mail ? 'yes' : 'no',
      gate: caps.mail ? undefined : 'caps.gate.mail',
    },
    {
      id: 'submission',
      label: 'caps.submission',
      state: caps.submission ? 'yes' : 'no',
      gate: caps.submission ? undefined : 'caps.gate.submission',
    },
    {
      id: 'contacts',
      label: 'caps.contacts',
      state: caps.contacts ? 'yes' : 'no',
      gate: caps.contacts ? undefined : 'caps.gate.contacts',
    },
    {
      id: 'calendars',
      label: 'caps.calendars',
      state: caps.calendars ? 'yes' : 'no',
      gate: caps.calendars ? undefined : 'caps.gate.calendars',
    },
    {
      id: 'vacation',
      label: 'caps.vacation',
      state: caps.vacation ? 'yes' : 'no',
      gate: caps.vacation ? undefined : 'caps.gate.vacation',
    },
    {
      id: 'sieve',
      label: 'caps.sieve',
      state: caps.sieve ? 'yes' : 'no',
      gate: caps.sieve ? 'caps.gate.sieve' : undefined,
    },
    {
      id: 'push',
      label: 'caps.push',
      state: 'info',
      value: caps.push === 'sse' ? 'caps.push.sse' : 'caps.push.poll',
    },
    {
      id: 'webPush',
      label: 'caps.webPush',
      state: caps.webPush ? 'yes' : 'no',
      gate: caps.webPush ? undefined : 'caps.gate.webPush',
    },
  ]
}
