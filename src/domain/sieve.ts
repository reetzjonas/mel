// Server-side mail filtering (Sieve, RFC 5228) as JMAP serves it (RFC 9661).
// Nothing in src/domain may import from src/providers.

export interface SieveScript {
  id: string
  name: string
  /** At most one script per account is active; that one is what runs. */
  isActive: boolean
  /**
   * Where the script text lives. Server-assigned and *not* the blob id
   * returned by the upload that supplied it, so reading a script back must
   * use this value.
   */
  blobId: string
}

/** Where the server says a script stops parsing. */
export interface SieveError {
  /** The server's own message; it names the line, and often the column. */
  message: string
}

/*
 * The structured form of a rule, which the guided editor works in and
 * lib/sieveScript.ts turns into Sieve. Deliberately a small subset of what
 * Sieve can express: it covers what a filter rule usually *is*, and anything
 * beyond it belongs in the script editor instead of in a form that would have
 * to grow a control per extension.
 */

export type ConditionField = 'from' | 'to' | 'cc' | 'subject'
export type ConditionOp = 'contains' | 'is'

export interface RuleCondition {
  field: ConditionField
  op: ConditionOp
  value: string
}

export type RuleAction =
  | { kind: 'fileinto'; mailbox: string }
  | { kind: 'flag' }
  | { kind: 'markRead' }
  | { kind: 'discard' }

export interface FilterRule {
  name: string
  /** Whether every condition has to match, or just one of them. */
  match: 'all' | 'any'
  conditions: RuleCondition[]
  actions: RuleAction[]
  /** Stop after this rule, so later ones cannot also act on the message. */
  stop: boolean
}
