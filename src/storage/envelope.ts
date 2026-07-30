/**
 * Payload envelope: every row stores its human-readable payload either as
 * `plain` (encryption off) or `enc` (AES-GCM ciphertext, written by the
 * Dexie DBCore middleware in Phase 5). Index columns on the row itself are
 * restricted to opaque ids, timestamps and flags — never readable content.
 * The seam exists from day one so enabling encryption later is a data
 * migration, not a schema redesign.
 */
export interface EncryptedPayload {
  v: 1
  /** 96-bit AES-GCM IV. */
  iv: Uint8Array
  /** Ciphertext of the JSON-serialized payload. */
  ct: Uint8Array
}

export interface Envelope<T> {
  plain?: T
  enc?: EncryptedPayload
}

/** Read helper for code paths that run before the crypto middleware exists. */
export function openEnvelope<T>(e: Envelope<T>): T {
  if (e.plain !== undefined) return e.plain
  throw new Error('Envelope is encrypted and no store-level decryption is active')
}

export function sealPlain<T>(value: T): Envelope<T> {
  return { plain: value }
}
