import type { DBCore, DBCoreMutateRequest, Middleware } from 'dexie'
import type { EncryptedPayload, Envelope } from '../envelope'
import { aeadOpen, aeadSeal, dekFor } from './keyring'
import { deserialize, serialize } from './serialize'

/**
 * Dexie DBCore middleware: transparently encrypts/decrypts the `payload`
 * envelope of rows belonging to encryption-enabled accounts. Index columns
 * stay plaintext (ids/timestamps/flags only). AES-GCM AAD binds each
 * ciphertext to its table + account, preventing row transplantation.
 *
 * Note: only get/getMany/query are wrapped. Cursor-based reads (.filter(),
 * .each(), .first() on filtered collections) would bypass decryption — app
 * code must stick to get/bulkGet/toArray, which openEnvelope() enforces by
 * throwing on sealed payloads.
 */

const ENCRYPTED_TABLES = new Set([
  'imageSenders',
  'sessions',
  'accounts',
  'mailboxes',
  'emails',
  'threads',
  'bodyCache',
  'blobCache',
  'outbox',
  'addressBooks',
  'contacts',
  'calendars',
  'events',
  'submissions',
  'pgpKeys',
])

/*
 * Encryption is per session: one passphrase, one key, for a login and every
 * account it reaches. Rows name their account, so the middleware needs each
 * account's session, synchronously — kept here, loaded at startup and
 * updated as accounts come and go. An account it does not know is taken to
 * be its own session, which every account from before sessions is.
 *
 * The AAD still binds a ciphertext to its table and account, not the
 * session: a row cannot be moved to another account of the same login.
 */
const sessionOfAccount = new Map<string, string>()

export function registerAccount(accountId: string, sessionId: string) {
  sessionOfAccount.set(accountId, sessionId)
}

export function forgetAccount(accountId: string) {
  sessionOfAccount.delete(accountId)
}

export function sessionOf(accountId: string): string {
  return sessionOfAccount.get(accountId) ?? accountId
}

// Which sessions have encryption enabled — kept in memory so the middleware
// can decide synchronously. Loaded at startup, updated on toggle.
const encryptedSessions = new Set<string>()

export function markSessionEncrypted(sessionId: string, on: boolean) {
  if (on) encryptedSessions.add(sessionId)
  else encryptedSessions.delete(sessionId)
}

export function isSessionEncrypted(sessionId: string): boolean {
  return encryptedSessions.has(sessionId)
}

/** The account's session, that is: they are encrypted together. */
export function markAccountEncrypted(accountId: string, on: boolean) {
  markSessionEncrypted(sessionOf(accountId), on)
}

export function isAccountEncrypted(accountId: string): boolean {
  return encryptedSessions.has(sessionOf(accountId))
}

type Row = { accountId?: string; id?: string; payload?: Envelope<unknown> } & Record<
  string,
  unknown
>

/** What the AAD binds the row to: the account, or for a session row the session. */
function accountIdOf(tableName: string, row: Row): string | undefined {
  return tableName === 'accounts' || tableName === 'sessions'
    ? (row.id as string | undefined)
    : row.accountId
}

/** Whose key seals the row: its session's. */
function keyDomainOf(tableName: string, row: Row): string | undefined {
  if (tableName === 'sessions') return row.id as string | undefined
  if (tableName === 'accounts') return (row.sessionId as string | undefined) ?? (row.id as string)
  return row.accountId === undefined ? undefined : sessionOf(row.accountId)
}

function aad(tableName: string, accountId: string): Uint8Array {
  return new TextEncoder().encode(`mel|${tableName}|${accountId}`)
}

// Synchronous crypto (see keyring.ts): async work inside DBCore operations
// would let the surrounding IndexedDB transaction auto-commit.

function sealRow(tableName: string, row: Row): Row {
  const payload = row.payload
  if (!payload || payload.plain === undefined) return row
  const accountId = accountIdOf(tableName, row)
  const domain = keyDomainOf(tableName, row)
  if (!accountId || !domain || !encryptedSessions.has(domain)) return row
  const dek = dekFor(domain)
  if (!dek) throw new Error(`mel: write to locked encrypted account ${accountId}`)
  const packed = aeadSeal(dek, serialize(payload.plain), aad(tableName, accountId))
  const enc: EncryptedPayload = { v: 1, iv: packed.slice(0, 12), ct: packed.slice(12) }
  return { ...row, payload: { enc } }
}

function openRow(tableName: string, row: unknown): unknown {
  const r = row as Row | undefined
  const enc = r?.payload?.enc
  if (!r || !enc) return row
  const accountId = accountIdOf(tableName, r)
  const domain = keyDomainOf(tableName, r)
  const dek = domain ? dekFor(domain) : null
  if (!dek || !accountId) return row // locked: leave sealed, openEnvelope() will throw
  try {
    const packed = new Uint8Array(12 + enc.ct.byteLength)
    packed.set(new Uint8Array(enc.iv), 0)
    packed.set(new Uint8Array(enc.ct), 12)
    const pt = aeadOpen(dek, packed, aad(tableName, accountId))
    return { ...r, payload: { plain: deserialize(pt) } }
  } catch {
    return row // tampered or foreign ciphertext: stays sealed
  }
}

export const cryptoMiddleware: Middleware<DBCore> = {
  stack: 'dbcore',
  name: 'mel-crypto',
  create: (down) => ({
    ...down,
    table: (tableName) => {
      const table = down.table(tableName)
      if (!ENCRYPTED_TABLES.has(tableName)) return table
      return {
        ...table,
        mutate(req: DBCoreMutateRequest) {
          if (req.type === 'add' || req.type === 'put') {
            const values = req.values.map((v) => sealRow(tableName, v as Row))
            return table.mutate({ ...req, values })
          }
          return table.mutate(req)
        },
        get(req) {
          return table.get(req).then((row) => openRow(tableName, row))
        },
        getMany(req) {
          return table.getMany(req).then((rows) => rows.map((r) => openRow(tableName, r)))
        },
        query(req) {
          return table.query(req).then((res) => {
            if (req.values && Array.isArray(res.result)) {
              return { ...res, result: res.result.map((r) => openRow(tableName, r)) }
            }
            return res
          })
        },
      }
    },
  }),
}
