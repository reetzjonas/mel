import type { Key, PrivateKey } from 'openpgp'
import { storedContact } from '../domain/contact'
import { keyKind, keyText } from '../domain/contactKey'
import type { KeyInfo, OwnKey } from '../domain/pgp'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'

/*
 * OpenPGP keys (issue #63): the user's own secret key, and the public keys on
 * contact cards. The library is loaded on first use — it is several hundred
 * kilobytes that most sessions never need.
 */

let lib: Promise<typeof import('openpgp')> | null = null
export const loadOpenpgp = () => (lib ??= import('openpgp'))

async function describe(key: Key): Promise<KeyInfo> {
  const expiry = await key.getExpirationTime().catch(() => null)
  const algo = key.getAlgorithmInfo()
  return {
    fingerprint: key.getFingerprint(),
    userIds: key.getUserIDs(),
    created: key.getCreationTime().toISOString(),
    expires: expiry instanceof Date ? expiry.toISOString() : null,
    revoked: await key.isRevoked().catch(() => false),
    algorithm: [algo.curve ?? algo.algorithm, algo.bits].filter(Boolean).join(' '),
  }
}

/** What a public key says about itself, or null for text that is not one. */
export async function describeKey(armored: string): Promise<KeyInfo | null> {
  const openpgp = await loadOpenpgp()
  try {
    return await describe(await openpgp.readKey({ armoredKey: armored }))
  } catch {
    return null
  }
}

async function readSecret(input: string | Uint8Array): Promise<PrivateKey | null> {
  const openpgp = await loadOpenpgp()
  try {
    return typeof input === 'string'
      ? await openpgp.readPrivateKey({ armoredKey: input })
      : await openpgp.readPrivateKey({ binaryKey: input })
  } catch {
    return null
  }
}

export type SecretKeyCheck =
  | { kind: 'invalid' }
  /** A public key where a secret one was expected — the usual mix-up. */
  | { kind: 'public' }
  | { kind: 'protected'; info: KeyInfo }
  /** Readable without a passphrase: import has to give it one. */
  | { kind: 'unprotected'; info: KeyInfo }

/** What an import would be dealing with, before it asks for a passphrase. */
export async function inspectSecretKey(input: string | Uint8Array): Promise<SecretKeyCheck> {
  const key = await readSecret(input)
  if (!key) {
    const openpgp = await loadOpenpgp()
    const isPublic = await (
      typeof input === 'string'
        ? openpgp.readKey({ armoredKey: input })
        : openpgp.readKey({ binaryKey: input })
    ).then(
      () => true,
      () => false,
    )
    return { kind: isPublic ? 'public' : 'invalid' }
  }
  const info = await describe(key)
  return key.isDecrypted() ? { kind: 'unprotected', info } : { kind: 'protected', info }
}

/*
 * Unlocked secret keys, per account and fingerprint. In memory only, for this
 * page's lifetime — the same shape as the database key in
 * storage/crypto/keyring.ts. Never sessionStorage: anything a script on the
 * origin can read back after a reload is no longer a session.
 */
const unlocked = new Map<string, Map<string, PrivateKey>>()
const listeners = new Set<() => void>()
let version = 0

function changed() {
  version++
  for (const fn of listeners) fn()
}

/** For useSyncExternalStore: moves whenever a key is unlocked, locked, added or removed. */
export function keysVersion(): number {
  return version
}

export function onKeysChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function remember(accountId: string, key: PrivateKey) {
  let keys = unlocked.get(accountId)
  if (!keys) unlocked.set(accountId, (keys = new Map()))
  keys.set(key.getFingerprint(), key)
}

export type ImportResult = 'ok' | 'invalid' | 'wrongPassphrase'

/**
 * Store the user's secret key.
 *
 * A protected key is kept exactly as exported, after checking the passphrase
 * opens it: a key imported with a passphrase nobody remembers is a key that
 * fails the first time a message needs it, far from where it went wrong.
 *
 * An unprotected key is sealed with `passphrase` before anything is written.
 * Storing it as it came would make "private key in readable IndexedDB" the
 * quiet default for exactly the people least likely to notice.
 */
export async function importOwnKey(
  accountId: string,
  input: string | Uint8Array,
  passphrase: string,
): Promise<ImportResult> {
  const openpgp = await loadOpenpgp()
  const key = await readSecret(input)
  if (!key || !passphrase) return 'invalid'
  let open: PrivateKey
  let sealed: PrivateKey
  if (key.isDecrypted()) {
    open = key
    sealed = await openpgp.encryptKey({ privateKey: key, passphrase })
  } else {
    try {
      open = await openpgp.decryptKey({ privateKey: key, passphrase })
    } catch {
      return 'wrongPassphrase'
    }
    sealed = key
  }
  const own: OwnKey = { ...(await describe(sealed)), armored: sealed.armor() }
  await db.pgpKeys.put({ accountId, fingerprint: own.fingerprint, payload: sealPlain(own) })
  // Just typed the passphrase: asking for it again on the first encrypted
  // message would be the second time in a minute.
  remember(accountId, open)
  changed()
  return 'ok'
}

export async function ownKeys(accountId: string): Promise<OwnKey[]> {
  const rows = await db.pgpKeys.where('accountId').equals(accountId).toArray()
  return rows.map((r) => openEnvelope(r.payload))
}

/** The public half of a stored key, for handing out. */
export async function publicArmor(own: OwnKey): Promise<string> {
  const openpgp = await loadOpenpgp()
  return (await openpgp.readPrivateKey({ armoredKey: own.armored })).toPublic().armor()
}

export async function removeOwnKey(accountId: string, fingerprint: string): Promise<void> {
  await db.pgpKeys.delete([accountId, fingerprint])
  unlocked.get(accountId)?.delete(fingerprint)
  changed()
}

/**
 * Open every stored key this passphrase fits. Returns how many it opened;
 * 0 means the passphrase is wrong for all of them.
 */
export async function unlockOwnKeys(accountId: string, passphrase: string): Promise<number> {
  const openpgp = await loadOpenpgp()
  let opened = 0
  for (const own of await ownKeys(accountId)) {
    try {
      const key = await openpgp.readPrivateKey({ armoredKey: own.armored })
      remember(accountId, await openpgp.decryptKey({ privateKey: key, passphrase }))
      opened++
    } catch {
      // Another key's passphrase, or this one's is wrong: try the next.
    }
  }
  if (opened) changed()
  return opened
}

export function unlockedKeys(accountId: string): PrivateKey[] {
  return [...(unlocked.get(accountId)?.values() ?? [])]
}

export function isUnlocked(accountId: string, fingerprint: string): boolean {
  return Boolean(unlocked.get(accountId)?.has(fingerprint))
}

/** Forget unlocked keys: one account's, or every account's. */
export function lockOwnKeys(accountId?: string) {
  if (accountId === undefined) unlocked.clear()
  else unlocked.delete(accountId)
  changed()
}

/**
 * The public keys on the cards of every contact with this address.
 *
 * Exact and case-insensitive, unlike the prefix search compose suggests from:
 * a key that belongs to a similar address is a key that belongs to someone
 * else. Several cards may carry the address, so every key from every one of
 * them counts.
 */
export async function contactKeysFor(accountId: string, email: string): Promise<Key[]> {
  const needle = email.trim().toLowerCase()
  if (!needle) return []
  const openpgp = await loadOpenpgp()
  const rows = await db.contacts.where('accountId').equals(accountId).toArray()
  const out: Key[] = []
  for (const row of rows) {
    const c = storedContact(openEnvelope(row.payload))
    if (!c.emails.some((e) => e.value.trim().toLowerCase() === needle)) continue
    for (const k of c.cryptoKeys) {
      const text = keyKind(k) === 'pgp' ? keyText(k) : null
      if (!text) continue
      try {
        out.push(...(await openpgp.readKeys({ armoredKeys: text })))
      } catch {
        // A damaged key on a card verifies nothing; the others still might.
      }
    }
  }
  return out
}
