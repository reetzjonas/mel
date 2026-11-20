import type { Account, Credentials, Session } from '../domain/account'
// db before the middleware: db.ts, crypto/keyring.ts and the middleware import
// each other, and entering that cycle through the middleware leaves it
// undefined when db.ts installs it (see migration.test.ts).
import { db, type AccountRow } from './db'
import { registerAccount } from './crypto/middleware'
import { openEnvelope, sealPlain } from './envelope'

/*
 * Sessions on this device, and the accounts each reaches.
 *
 * An account from before sessions (schema 12) is its own session under its
 * own id, with the credentials still in the account's payload. They move to a
 * session row the first time they are read with the key at hand: a schema
 * upgrade runs before any passphrase is entered, so it cannot open a sealed
 * payload to split it.
 */

/** Move a pre-session account's credentials to its session. Locked: left for later. */
async function moveCredentials(row: AccountRow): Promise<void> {
  let stored: { account: Account; credentials?: Credentials }
  try {
    stored = openEnvelope(row.payload)
  } catch {
    return
  }
  const { account, credentials } = stored
  if (!credentials) return
  const sessionId = row.sessionId ?? row.id
  await db.transaction('rw', db.sessions, db.accounts, async () => {
    if (!(await db.sessions.get(sessionId))) {
      const session: Session = {
        id: sessionId,
        provider: account.provider,
        sessionUrl: account.sessionUrl,
        label: credentials.username || account.label,
      }
      await db.sessions.put({
        id: sessionId,
        provider: row.provider,
        encrypted: row.encrypted,
        pushDetails: row.pushDetails,
        payload: sealPlain({ session, credentials }),
      })
    }
    await db.accounts.put({
      ...row,
      sessionId,
      payload: sealPlain({ account: { ...account, sessionId } }),
    })
  })
}

/** Every pre-session account that can be read now, given its session. */
export async function migrateLegacySessions(): Promise<void> {
  for (const row of await db.accounts.toArray()) await moveCredentials(row)
}

export async function storedSession(
  sessionId: string,
): Promise<{ session: Session; credentials: Credentials }> {
  let row = await db.sessions.get(sessionId)
  if (!row) {
    const legacy = await db.accounts.get(sessionId)
    if (legacy) await moveCredentials(legacy)
    row = await db.sessions.get(sessionId)
  }
  if (!row) throw new Error(`Session ${sessionId} not found`)
  return openEnvelope(row.payload)
}

/** An account, with the credentials of the session it is reached through. */
export async function storedAccount(
  accountId: string,
): Promise<{ account: Account; credentials: Credentials }> {
  const row = await db.accounts.get(accountId)
  if (!row) throw new Error(`Account ${accountId} not found`)
  const sessionId = row.sessionId ?? row.id
  const { credentials } = await storedSession(sessionId)
  const { account } = openEnvelope((await db.accounts.get(accountId))?.payload ?? row.payload)
  return { account: { ...account, sessionId }, credentials }
}

/**
 * The ids of a session's accounts on this device — including one with no
 * session column at all, which is its own session.
 */
export async function accountsOfSession(sessionId: string): Promise<string[]> {
  const ids = (await db.accounts.where('sessionId').equals(sessionId).primaryKeys()).map(String)
  const own = await db.accounts.get(sessionId)
  if (own && !own.sessionId && !ids.includes(sessionId)) ids.push(sessionId)
  return ids
}

/**
 * Set a session's flags. On its row where it has one; otherwise on its
 * accounts' rows, where they lived before sessions and are read from until
 * the credentials move.
 */
export async function setSessionFlags(
  sessionId: string,
  flags: { encrypted?: boolean; pushDetails?: boolean },
): Promise<void> {
  const row = await db.sessions.get(sessionId)
  if (row) {
    await db.sessions.put({ ...row, ...flags })
    return
  }
  for (const id of await accountsOfSession(sessionId)) {
    const account = await db.accounts.get(id)
    if (account) await db.accounts.put({ ...account, ...flags })
  }
}

/** A session's flags, read the same way they are set. */
export async function sessionFlags(
  sessionId: string,
): Promise<{ encrypted: boolean; pushDetails: boolean }> {
  const row = (await db.sessions.get(sessionId)) ?? (await db.accounts.get(sessionId))
  return { encrypted: Boolean(row?.encrypted), pushDetails: Boolean(row?.pushDetails) }
}

/** Tell the crypto middleware which session every account belongs to. Call at startup. */
export async function loadAccountSessions(): Promise<void> {
  for (const row of await db.accounts.toArray()) registerAccount(row.id, row.sessionId ?? row.id)
}

/** Store a new account of a session; it starts syncing when the scheduler next looks. */
export async function storeAccount(account: Account): Promise<void> {
  registerAccount(account.id, account.sessionId)
  await db.accounts.put({
    id: account.id,
    sessionId: account.sessionId,
    provider: account.provider,
    encrypted: false,
    payload: sealPlain({ account }),
  })
}
