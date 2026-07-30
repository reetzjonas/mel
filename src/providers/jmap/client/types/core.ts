// Hand-written types for JMAP Core (RFC 8620). Only what we use.

export const Cap = {
  core: 'urn:ietf:params:jmap:core',
  mail: 'urn:ietf:params:jmap:mail',
  submission: 'urn:ietf:params:jmap:submission',
  vacation: 'urn:ietf:params:jmap:vacationresponse',
  contacts: 'urn:ietf:params:jmap:contacts',
  calendars: 'urn:ietf:params:jmap:calendars',
  sieve: 'urn:ietf:params:jmap:sieve',
  blob: 'urn:ietf:params:jmap:blob',
  websocket: 'urn:ietf:params:jmap:websocket',
  webpushVapid: 'urn:ietf:params:jmap:webpush-vapid',
} as const

export interface JmapSession {
  capabilities: Record<string, unknown>
  accounts: Record<string, JmapAccount>
  primaryAccounts: Record<string, string>
  username: string
  apiUrl: string
  downloadUrl: string
  uploadUrl: string
  eventSourceUrl: string
  state: string
}

export interface JmapAccount {
  name: string
  isPersonal: boolean
  isReadOnly: boolean
  accountCapabilities: Record<string, unknown>
}

export interface CoreCapability {
  maxSizeUpload: number
  maxConcurrentUpload: number
  maxSizeRequest: number
  maxConcurrentRequests: number
  maxCallsInRequest: number
  maxObjectsInGet: number
  maxObjectsInSet: number
}

/** [methodName, args, callId] */
export type Invocation = [string, Record<string, unknown>, string]

export interface JmapRequest {
  using: string[]
  methodCalls: Invocation[]
  createdIds?: Record<string, string>
}

export interface JmapResponse {
  methodResponses: Invocation[]
  createdIds?: Record<string, string>
  sessionState: string
}

/** Request-level error (RFC 8620 §3.6.1), delivered as HTTP problem details. */
export interface JmapProblem {
  type: string
  status?: number
  detail?: string
  limit?: string
}

export interface MethodError {
  type: string
  description?: string
}

export interface ResultReference {
  resultOf: string
  name: string
  path: string
}

export interface GetArgs {
  accountId: string
  ids?: string[] | null
  properties?: string[]
}

export interface GetResponse<T> {
  accountId: string
  state: string
  list: T[]
  notFound: string[]
}

export interface ChangesArgs {
  accountId: string
  sinceState: string
  maxChanges?: number
}

export interface ChangesResponse {
  accountId: string
  oldState: string
  newState: string
  hasMoreChanges: boolean
  created: string[]
  updated: string[]
  destroyed: string[]
}

export interface QueryResponse {
  accountId: string
  queryState: string
  canCalculateChanges: boolean
  position: number
  ids: string[]
  total?: number
  limit?: number
}

export interface SetError {
  type: string
  description?: string
  properties?: string[]
}

export interface SetResponse<T> {
  accountId: string
  oldState: string | null
  newState: string
  created?: Record<string, T>
  updated?: Record<string, T | null>
  destroyed?: string[]
  notCreated?: Record<string, SetError>
  notUpdated?: Record<string, SetError>
  notDestroyed?: Record<string, SetError>
}

export interface StateChange {
  '@type': 'StateChange'
  changed: Record<string, Record<string, string>>
}
