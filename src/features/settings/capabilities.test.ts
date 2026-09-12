import { describe, expect, it } from 'vitest'
import type { AccountCapabilities } from '../../domain/account'
import { capabilityRows } from './capabilities'

const caps = (over: Partial<AccountCapabilities> = {}): AccountCapabilities => ({
  mail: true,
  submission: true,
  contacts: true,
  calendars: true,
  sieve: false,
  vacation: true,
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

  it('flags sieve as supported-but-unimplemented rather than as a gate', () => {
    expect(row(caps({ sieve: true }), 'sieve').gate).toBe('caps.gate.sieve')
    expect(row(caps({ sieve: false }), 'sieve').gate).toBeUndefined()
  })
})
