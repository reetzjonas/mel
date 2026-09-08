/**
 * Classify the browser's opaque connection failure.
 *
 * `fetch()` rejects with a bare "TypeError: Failed to fetch" for a CORS
 * rejection, a DNS miss, a refused connection, a bad TLS certificate and a
 * dropped network alike. The Fetch spec hides which one on purpose, so no
 * amount of cleverness recovers the real cause here — we must not claim "CORS
 * error" when we cannot know. Naming the handful of candidates, and pointing at
 * the browser console where the true reason *is* printed, is the honest best.
 */
const OPAQUE = /failed to fetch|networkerror|load failed|network request failed/i

export function isOpaqueNetworkFailure(e: unknown): boolean {
  if (e instanceof Error) return OPAQUE.test(e.message)
  return false
}

export type ConnectionErrorKind = 'unreachable' | 'auth' | 'other'

export interface ConnectionError {
  kind: ConnectionErrorKind
  /** Raw message, for the tooltip — never the whole story, see above. */
  detail: string
}

export function classifyConnectionError(e: unknown): ConnectionError {
  const detail = e instanceof Error ? e.message : String(e)
  if (isOpaqueNetworkFailure(e)) return { kind: 'unreachable', detail }
  if (e instanceof Error && (e as { kind?: string }).kind === 'auth')
    return { kind: 'auth', detail }
  return { kind: 'other', detail }
}
