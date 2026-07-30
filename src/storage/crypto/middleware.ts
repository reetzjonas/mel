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
])

// Which accounts have encryption enabled — kept in memory so the middleware
// can decide synchronously. Loaded at startup, updated on toggle.
const encryptedAccounts = new Set<string>()

export function markAccountEncrypted(accountId: string, on: boolean) {
  if (on) encryptedAccounts.add(accountId)
  else encryptedAccounts.delete(accountId)
}

export function isAccountEncrypted(accountId: string): boolean {
  return encryptedAccounts.has(accountId)
}

type Row = { accountId?: string; id?: string; payload?: Envelope<unknown> } & Record<
  string,
  unknown
>

function accountIdOf(tableName: string, row: Row): string | undefined {
  return tableName === 'accounts' ? (row.id as string | undefined) : row.accountId
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
  if (!accountId || !encryptedAccounts.has(accountId)) return row
  const dek = dekFor(accountId)
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
  const dek = accountId ? dekFor(accountId) : null
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
