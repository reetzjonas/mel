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
