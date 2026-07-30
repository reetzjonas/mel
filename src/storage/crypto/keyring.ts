import { gcm } from '@noble/ciphers/aes.js'
import { db } from '../db'
import { deriveKek, newKdfSpec, type KdfSpec } from './kdf'

/**
 * Key hierarchy: passphrase → (Argon2id/PBKDF2) → KEK → wraps → DEK
 * (random 256-bit AES-GCM key, generated once per account). Changing the
 * passphrase only re-wraps the DEK — data is never re-encrypted.
 * A verifier (encryption of a known constant) detects wrong passphrases.
 *
 * AES-GCM runs through @noble/ciphers (synchronous): the Dexie DBCore
 * middleware must encrypt inside IndexedDB transactions, where awaiting
 * WebCrypto promises would let the transaction auto-commit.
 */

const VERIFIER_PLAINTEXT = new TextEncoder().encode('mel-keyring-v1')
const unlocked = new Map<string, Uint8Array>()

export function aeadSeal(key: Uint8Array, data: Uint8Array, aad?: Uint8Array): Uint8Array {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct = gcm(key, nonce, aad).encrypt(data)
  const out = new Uint8Array(12 + ct.length)
  out.set(nonce, 0)
  out.set(ct, 12)
  return out
}

/** Throws on tamper/wrong key. */
export function aeadOpen(key: Uint8Array, packed: Uint8Array, aad?: Uint8Array): Uint8Array {
  return gcm(key, packed.slice(0, 12), aad).decrypt(packed.slice(12))
}

async function newKekFor(passphrase: string): Promise<{ spec: KdfSpec; kek: Uint8Array }> {
  let spec: KdfSpec = newKdfSpec(true)
  try {
    return { spec, kek: await deriveKek(passphrase, spec) }
  } catch {
    spec = newKdfSpec(false)
    return { spec, kek: await deriveKek(passphrase, spec) }
  }
}

/** Set up encryption for an account: generates a DEK and wraps it. */
export async function initKeyring(accountId: string, passphrase: string): Promise<void> {
  const { spec, kek } = await newKekFor(passphrase)
  const dek = crypto.getRandomValues(new Uint8Array(32))
  await db.keyring.put({
    accountId,
    kdf: spec,
    wrappedDek: aeadSeal(kek, dek),
    verifier: aeadSeal(dek, VERIFIER_PLAINTEXT),
  })
  kek.fill(0)
  unlocked.set(accountId, dek)
}

/** Unlock with the passphrase; returns false when it is wrong. */
export async function unlock(accountId: string, passphrase: string): Promise<boolean> {
  const row = await db.keyring.get(accountId)
  if (!row) return false
  try {
    const kek = await deriveKek(passphrase, row.kdf as KdfSpec)
    const dek = aeadOpen(kek, new Uint8Array(row.wrappedDek))
    kek.fill(0)
    aeadOpen(dek, new Uint8Array(row.verifier)) // throws on wrong key
    unlocked.set(accountId, dek)
    return true
  } catch {
    return false
  }
}

/** Re-wrap the DEK under a new passphrase. No data re-encryption. */
export async function changePassphrase(
  accountId: string,
  oldPassphrase: string,
  newPassphrase: string,
): Promise<boolean> {
  const row = await db.keyring.get(accountId)
  if (!row) return false
  try {
    const oldKek = await deriveKek(oldPassphrase, row.kdf as KdfSpec)
    const dek = aeadOpen(oldKek, new Uint8Array(row.wrappedDek))
    oldKek.fill(0)
    const { spec, kek } = await newKekFor(newPassphrase)
    await db.keyring.put({ ...row, kdf: spec, wrappedDek: aeadSeal(kek, dek) })
    kek.fill(0)
    dek.fill(0)
    return true
  } catch {
    return false
  }
}

export function dekFor(accountId: string): Uint8Array | null {
  return unlocked.get(accountId) ?? null
}

export function lock(accountId?: string) {
  if (accountId) {
    unlocked.get(accountId)?.fill(0)
    unlocked.delete(accountId)
  } else {
    for (const dek of unlocked.values()) dek.fill(0)
    unlocked.clear()
  }
}

export async function hasKeyring(accountId: string): Promise<boolean> {
  return (await db.keyring.get(accountId)) !== undefined
}

export async function removeKeyring(accountId: string): Promise<void> {
  lock(accountId)
  await db.keyring.delete(accountId)
}
