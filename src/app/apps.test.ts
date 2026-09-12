import { describe, expect, it } from 'vitest'
import type { Account, AccountCapabilities } from '../domain/account'
import { visibleApps } from './apps'

const caps = (over: Partial<AccountCapabilities> = {}): AccountCapabilities => ({
  mail: true,
  submission: true,
  contacts: true,
  calendars: true,
  sieve: false,
  vacation: false,
  push: 'poll',
  webPush: false,
  ...over,
})

const account = (over: Partial<AccountCapabilities> = {}): Account => ({
  id: 'account-1',
  provider: 'jmap',
  label: 'alice@example.test',
  remoteAccountId: 'remote-1',
  sessionUrl: 'https://example.test/.well-known/jmap',
  capabilities: caps(over),
  encrypted: false,
})

const tabs = (a: Account | undefined) => visibleApps(a).map((t) => t.to)

describe('visibleApps', () => {
  it('offers only Mail before an account exists, since it holds the login form', () => {
    expect(tabs(undefined)).toEqual(['/mail'])
  })

  it('hides Mail on a server that does not offer it', () => {
    // Was shown unconditionally once, which put a permanently empty mail view
    // in front of anyone on a calendar-only server.
    expect(tabs(account({ mail: false }))).toEqual(['/calendar', '/contacts'])
  })

  it('hides each of the other tabs with its own capability', () => {
    expect(tabs(account({ calendars: false }))).toEqual(['/mail', '/contacts'])
    expect(tabs(account({ contacts: false }))).toEqual(['/mail', '/calendar'])
  })

  it('shows all three when the server offers all three', () => {
    expect(tabs(account())).toEqual(['/mail', '/calendar', '/contacts'])
  })

  it('does not hang the mail tab on the sending capability', () => {
    // Reading mail on a server that takes none for delivery is perfectly
    // normal; only the controls that write a message go away.
    expect(tabs(account({ submission: false }))).toContain('/mail')
  })
})
