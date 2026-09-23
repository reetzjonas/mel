// Provider-agnostic account model. Nothing in src/domain may import from
// src/providers — the dependency points the other way.

export type ProviderKind = 'jmap'

/**
 * `oauth` is a refresh token from the server's own token login (Stalwart's
 * `/api/auth`): the password is used once to get it and never stored.
 */
export type AuthMethod = 'basic' | 'bearer' | 'oauth'

export interface Credentials {
  method: AuthMethod
  /** Username for basic auth (usually the email address). */
  username?: string
  /** Password (basic), API token (bearer) or refresh token (oauth). */
  secret: string
  /** oauth only: where the refresh token is exchanged for access tokens. */
  tokenEndpoint?: string
  /** oauth only: the client the token was issued to; renewals must name it. */
  clientId?: string
}

/** Feature flags derived from server capabilities; the UI renders only what's supported. */
export interface AccountCapabilities {
  mail: boolean
  submission: boolean
  contacts: boolean
  calendars: boolean
  /** The server lets this account create calendars (`mayCreateCalendar`, true unless it says no). */
  calendarCreate: boolean
  sieve: boolean
  vacation: boolean
  /** Server-side file storage (JMAP FileNode). */
  files: boolean
  /** Storage usage and limit (JMAP Quota, RFC 9425). */
  quota: boolean
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
