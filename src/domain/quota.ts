// Provider-agnostic storage quota, from JMAP Quota (RFC 9425). Nothing in
// src/domain may import from src/providers — the dependency points the other way.

export interface StorageQuota {
  /**
   * Octets in use, counted across every data type the server bills to the
   * account — mail, files, calendars, contacts and filter scripts alike. It is
   * account-wide, not per app.
   */
  used: number
  /** Octets the account may not exceed. */
  limit: number
}
