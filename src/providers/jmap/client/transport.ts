import type { Credentials } from '../../../domain/account'
import { authorizedFetch } from './auth'
import { JmapError, toError } from './errors'
import type { JmapRequest, JmapResponse } from './types/core'

export { JmapError, toError, type JmapErrorKind } from './errors'
export { authHeader } from './auth'

export interface Transport {
  request(req: JmapRequest, signal?: AbortSignal): Promise<JmapResponse>
  fetchRaw(url: string, init?: RequestInit): Promise<Response>
}

export function createTransport(apiUrl: string, creds: Credentials): Transport {
  async function fetchRaw(url: string, init?: RequestInit): Promise<Response> {
    let res: Response
    try {
      res = await authorizedFetch(creds, url, init)
    } catch (e) {
      // A token that could not be renewed is already the error to act on.
      if (e instanceof JmapError) throw e
      throw new JmapError(e instanceof Error ? e.message : 'network error', 'network')
    }
    if (!res.ok) throw await toError(res)
    return res
  }

  return {
    fetchRaw,
    async request(req, signal) {
      const res = await fetchRaw(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal,
      })
      return (await res.json()) as JmapResponse
    },
  }
}
