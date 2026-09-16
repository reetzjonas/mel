import { describe, expect, it, vi } from 'vitest'
import type { StorageQuota } from '../domain/quota'

let hasProvider = true
let reported: StorageQuota | null = { used: 10, limit: 100 }

vi.mock('../sync/connections', () => ({
  connectionFor: () =>
    Promise.resolve({ quota: hasProvider ? { storage: () => Promise.resolve(reported) } : null }),
}))

const { storageQuota } = await import('./quota')

describe('reading the account quota', () => {
  it('passes the server figure through', async () => {
    hasProvider = true
    reported = { used: 10, limit: 100 }
    expect(await storageQuota('acc')).toEqual({ used: 10, limit: 100 })
  })

  // A server without the capability has no quota provider at all, and that is
  // not a failure — it is an account nothing limits.
  it('reports no quota when the server does not offer one', async () => {
    hasProvider = false
    expect(await storageQuota('acc')).toBeNull()
  })
})
