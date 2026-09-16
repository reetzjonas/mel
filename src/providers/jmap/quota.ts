import type { StorageQuota } from '../../domain/quota'
import type { QuotaProvider } from '../types'
import { Batch } from './client/request'
import type { Transport } from './client/transport'
import { Cap, type GetResponse } from './client/types/core'

const USING = [Cap.core, Cap.quota]

// Quota objects as served by RFC 9425. Only what we use; the spec also carries
// warnLimit, softLimit, name, description and types.
interface JmapQuota {
  id: string
  resourceType?: string | null
  used?: number | null
  hardLimit?: number | null
  scope?: string | null
}

export function createJmapQuota(transport: Transport, accountId: string): QuotaProvider {
  return {
    async storage(): Promise<StorageQuota | null> {
      const b = new Batch(transport, USING)
      // `ids: null` is the spec's "every record"; a quota set is a handful of
      // objects at most, so there is nothing to page through.
      const g = b.call<GetResponse<JmapQuota>>('Quota/get', { accountId, ids: null })
      await b.send()
      const octets = g.result.list.find(
        (q) => q.resourceType === 'octets' && q.scope === 'account',
      )
      // An account with no limit configured has no quota object at all — which
      // means unlimited, not empty, so there is no usage worth showing.
      if (!octets || typeof octets.hardLimit !== 'number' || octets.hardLimit <= 0) return null
      return { used: Math.max(0, octets.used ?? 0), limit: octets.hardLimit }
    },
  }
}
