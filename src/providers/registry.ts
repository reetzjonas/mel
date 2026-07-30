import type { Account } from '../domain/account'
import { jmapProvider } from './jmap'
import type { Provider } from './types'

const providers: Record<Account['provider'], Provider> = {
  jmap: jmapProvider,
}

export function providerFor(kind: Account['provider']): Provider {
  const p = providers[kind]
  if (!p) throw new Error(`Unknown provider: ${kind}`)
  return p
}
