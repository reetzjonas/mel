import { describe, expect, it } from 'vitest'
import type { AccountCapabilities } from '../../domain/account'
import { capabilityRows } from './capabilities'

const caps = (over: Partial<AccountCapabilities> = {}): AccountCapabilities => ({
  mail: true,
  submission: true,
  contacts: true,
  calendars: true,
  calendarCreate: true,
  sieve: false,
  vacation: true,
  files: false,
  quota: false,
  push: 'sse',
  webPush: true,
  ...over,
})

const row = (c: AccountCapabilities, id: string) => capabilityRows(c).find((r) => r.id === id)!

describe('capabilityRows', () => {
  it('covers every capability flag exactly once', () => {
    const ids = capabilityRows(caps()).map((r) => r.id)
    expect([...ids].sort()).toEqual(Object.keys(caps()).sort())
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('explains the gate only when something is actually hidden', () => {
    expect(row(caps({ calendars: false }), 'calendars').gate).toBe('caps.gate.calendars')
    expect(row(caps({ calendars: true }), 'calendars').gate).toBeUndefined()
  })

  it('says the "+" for a new calendar is gone when the server forbids creating one', () => {
    expect(row(caps({ calendarCreate: false }), 'calendarCreate').gate).toBe(
      'caps.gate.calendarCreate',
    )
    expect(row(caps({ calendarCreate: true }), 'calendarCreate').gate).toBeUndefined()
  })

  it('reports the live-update transport as a value, not a yes/no', () => {
    expect(row(caps({ push: 'sse' }), 'push')).toMatchObject({
      state: 'info',
      value: 'caps.push.sse',
    })
    expect(row(caps({ push: 'poll' }), 'push').value).toBe('caps.push.poll')
  })

  it('names the gate mail and submission each really have', () => {
    // Both used to say "nothing is gated here" out loud. They are gated now —
    // the Mail tab goes, and nothing offers to write a message — so the row
    // has to say that instead.
    expect(row(caps({ submission: false }), 'submission').gate).toBe('caps.gate.submission')
    expect(row(caps({ submission: true }), 'submission').gate).toBeUndefined()
    expect(row(caps({ mail: false }), 'mail').gate).toBe('caps.gate.mail')
    expect(row(caps({ mail: true }), 'mail').gate).toBeUndefined()
  })

  it('names what sieve gates, now that there is an editor behind it', () => {
    // It used to read "your server supports it, we have not built it" — a
    // promise that stopped being true the day the filter rules section landed.
    expect(row(caps({ sieve: false }), 'sieve').gate).toBe('caps.gate.sieve')
    expect(row(caps({ sieve: true }), 'sieve').gate).toBeUndefined()
  })
})
