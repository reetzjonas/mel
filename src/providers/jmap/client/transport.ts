import type { Credentials } from '../../../domain/account'
import type { JmapProblem, JmapRequest, JmapResponse } from './types/core'

export type JmapErrorKind = 'auth' | 'network' | 'server' | 'protocol' | 'ratelimit'

export class JmapError extends Error {
  /** Coarse taxonomy the sync engine acts on. */
  readonly kind: JmapErrorKind
  readonly problem?: JmapProblem
  readonly status?: number
  /** Retry-After in ms, when the server sent one. */
  readonly retryAfterMs?: number

  constructor(
    message: string,
    kind: JmapErrorKind,
    problem?: JmapProblem,
    status?: number,
    retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'JmapError'
    this.kind = kind
    this.problem = problem
    this.status = status
    this.retryAfterMs = retryAfterMs
  }

  get transient(): boolean {
    return this.kind === 'network' || this.kind === 'server' || this.kind === 'ratelimit'
  }
}

export function authHeader(creds: Credentials): string {
  if (creds.method === 'bearer') return `Bearer ${creds.secret}`
  return `Basic ${btoa(`${creds.username ?? ''}:${creds.secret}`)}`
}

async function toError(res: Response): Promise<JmapError> {
  let problem: JmapProblem | undefined
  try {
    problem = (await res.json()) as JmapProblem
  } catch {
    /* non-JSON error body */
  }
  const retryAfter = res.headers.get('Retry-After')
  const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined
  const msg = problem?.detail ?? `HTTP ${res.status}`
  if (res.status === 401 || res.status === 403) return new JmapError(msg, 'auth', problem, res.status)
  if (res.status === 429)
    return new JmapError(msg, 'ratelimit', problem, res.status, retryAfterMs ?? 30_000)
  if (res.status >= 500) return new JmapError(msg, 'server', problem, res.status)
  return new JmapError(msg, 'protocol', problem, res.status)
}

export interface Transport {
  request(req: JmapRequest, signal?: AbortSignal): Promise<JmapResponse>
  fetchRaw(url: string, init?: RequestInit): Promise<Response>
}

export function createTransport(apiUrl: string, creds: Credentials): Transport {
  const headers = { Authorization: authHeader(creds) }

  async function fetchRaw(url: string, init?: RequestInit): Promise<Response> {
    let res: Response
    try {
      res = await fetch(url, { ...init, headers: { ...headers, ...init?.headers } })
    } catch (e) {
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
