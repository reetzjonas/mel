import type { SieveScript } from '../domain/sieve'
import { isActiveScript, isSyntaxError } from '../providers/jmap/sieve'
import type { SetFailure, SieveProvider, SieveScriptEdit } from '../providers/types'
import { connectionFor } from '../sync/connections'

/**
 * Sieve scripts, server-first and never queued.
 *
 * There is no local mirror and no outbox action: the server is the only thing
 * that can say whether a script parses, so an edit that has not reached it
 * has not been checked either. Everything here reports what happened instead
 * of retrying later.
 */

async function provider(accountId: string): Promise<SieveProvider | null> {
  return (await connectionFor(accountId)).sieve
}

/** Why a write was refused, so the UI can offer the matching way out. */
export type SieveBlocker = 'syntax' | 'active' | 'other'

export interface SieveOutcome {
  ok: boolean
  blocker?: SieveBlocker
  /** The server's own words — for a syntax error, the line and column. */
  message?: string
}

function outcome(failure: SetFailure | null): SieveOutcome {
  if (!failure) return { ok: true }
  const blocker: SieveBlocker = isSyntaxError(failure)
    ? 'syntax'
    : isActiveScript(failure)
      ? 'active'
      : 'other'
  return { ok: false, blocker, message: failure.description ?? failure.type }
}

export async function listScripts(accountId: string): Promise<SieveScript[]> {
  const sieve = await provider(accountId)
  return sieve ? sieve.listScripts() : []
}

export async function readScript(accountId: string, script: SieveScript): Promise<string> {
  const sieve = await provider(accountId)
  return sieve ? sieve.readScript(script) : ''
}

/** null when the script parses; otherwise what the server objected to. */
export async function checkScript(accountId: string, content: string): Promise<string | null> {
  const sieve = await provider(accountId)
  return sieve ? sieve.validate(content) : null
}

export async function saveScript(accountId: string, edit: SieveScriptEdit): Promise<SieveOutcome> {
  const sieve = await provider(accountId)
  if (!sieve) return { ok: false, blocker: 'other', message: 'noProvider' }
  return outcome((await sieve.saveScript(edit)).failure)
}

/** `null` switches filtering off rather than choosing another script. */
export async function setActiveScript(accountId: string, id: string | null): Promise<SieveOutcome> {
  const sieve = await provider(accountId)
  if (!sieve) return { ok: false, blocker: 'other', message: 'noProvider' }
  return outcome(await sieve.setActive(id))
}

/**
 * Delete a script.
 *
 * The active one is refused outright, which is worth keeping as its own
 * blocker: "deactivate it first" is a thing the user can act on, where the
 * server's raw message is only an explanation.
 */
export async function deleteScript(accountId: string, id: string): Promise<SieveOutcome> {
  const sieve = await provider(accountId)
  if (!sieve) return { ok: false, blocker: 'other', message: 'noProvider' }
  return outcome(await sieve.destroyScript(id))
}
