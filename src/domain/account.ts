// Provider-agnostic account model. Nothing in src/domain may import from
// src/providers — the dependency points the other way.

export type ProviderKind = 'jmap'

export type AuthMethod = 'basic' | 'bearer'

export interface Credentials {
  method: AuthMethod
  /** Username for basic auth (usually the email address). */
  username?: string
  /** Password (basic) or API token (bearer). */
  secret: string
}

/** Feature flags derived from server capabilities; the UI renders only what's supported. */
export interface AccountCapabilities {
  mail: boolean
  submission: boolean
  contacts: boolean
  calendars: boolean
  sieve: boolean
  vacation: boolean
  /** How live updates arrive. */
  push: 'sse' | 'poll'
  /** Web Push at closed-app time (RFC 9749 VAPID capability present). */
  webPush: boolean
}

export interface Account {
  /** Local UUID, stable across sessions. Not the provider's account id. */
  id: string
  provider: ProviderKind
  /** Display name, e.g. the email address. */
  label: string
  /** Provider-side account id (JMAP: from the session object). */
  remoteAccountId: string
  /** JMAP session URL (or provider equivalent). */
  sessionUrl: string
  capabilities: AccountCapabilities
  /** Whether at-rest encryption is enabled for this account's data. */
  encrypted: boolean
}
