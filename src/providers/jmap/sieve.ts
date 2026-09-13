import type { SieveScript } from '../../domain/sieve'
import type { SetFailure, SieveProvider, SieveScriptEdit } from '../types'
import { Batch } from './client/request'
import type { Transport } from './client/transport'
import { Cap, type GetResponse, type SetError, type SetResponse } from './client/types/core'

const USING = [Cap.core, Cap.sieve]

/** What a Sieve blob is uploaded as; anything else risks a reject on type. */
const SIEVE_TYPE = 'application/sieve'

/*
 * RFC 9661 names these `invalidSieve` and `sieveIsActive`. Stalwart answers
 * with `invalidScript` and `scriptIsActive` — the same two conditions under
 * different names. Matching only the registered spelling would turn a syntax
 * error into "something went wrong" on the one server we can actually test
 * against, so both are accepted.
 */
const INVALID_SCRIPT = new Set(['invalidSieve', 'invalidScript'])
const SCRIPT_IS_ACTIVE = new Set(['sieveIsActive', 'scriptIsActive'])

export function isSyntaxError(failure: SetFailure): boolean {
  return INVALID_SCRIPT.has(failure.type)
}

export function isActiveScript(failure: SetFailure): boolean {
  return SCRIPT_IS_ACTIVE.has(failure.type)
}

const PERMANENT = new Set([
  'invalidProperties',
  'invalidPatch',
  'notFound',
  'forbidden',
  'overQuota',
  'tooLarge',
  ...INVALID_SCRIPT,
  ...SCRIPT_IS_ACTIVE,
])

function toFailure(e: SetError | undefined): SetFailure {
  return {
    type: e?.type ?? 'serverFail',
    description: e?.description,
    permanent: e ? PERMANENT.has(e.type) : false,
  }
}

interface JmapSieveScript {
  id: string
  name?: string | null
  blobId?: string | null
  isActive?: boolean | null
}

function toScript(s: JmapSieveScript): SieveScript {
  return {
    id: s.id,
    name: s.name ?? '',
    blobId: s.blobId ?? '',
    isActive: s.isActive === true,
  }
}

export function createJmapSieve(
  transport: Transport,
  accountId: string,
  uploadUrl: string,
  downloadUrl: string,
): SieveProvider {
  const batch = () => new Batch(transport, USING)

  async function upload(content: string): Promise<string> {
    const url = uploadUrl.replace('{accountId}', encodeURIComponent(accountId))
    const res = await transport.fetchRaw(url, {
      method: 'POST',
      headers: { 'Content-Type': SIEVE_TYPE },
      body: content,
    })
    const j = (await res.json()) as { blobId: string }
    return j.blobId
  }

  return {
    async listScripts(): Promise<SieveScript[]> {
      const b = batch()
      const g = b.call<GetResponse<JmapSieveScript>>('SieveScript/get', { accountId, ids: null })
      await b.send()
      return g.result.list.map(toScript)
    },

    async readScript(script: SieveScript): Promise<string> {
      if (!script.blobId) return ''
      const url = downloadUrl
        .replace('{accountId}', encodeURIComponent(accountId))
        .replace('{blobId}', encodeURIComponent(script.blobId))
        .replace('{type}', encodeURIComponent(SIEVE_TYPE))
        .replace('{name}', encodeURIComponent(script.name || 'script'))
      const res = await transport.fetchRaw(url)
      return res.text()
    },

    /**
     * Ask the server whether the script parses, without storing it.
     *
     * The content still has to be uploaded first — validate takes a blob id,
     * not text — so this costs an upload either way. Worth it: the answer
     * names the line and usually the column, which is the whole point of
     * offering an editor rather than a text box.
     */
    async validate(content: string): Promise<string | null> {
      const blobId = await upload(content)
      const b = batch()
      const v = b.call<{ error: SetError | null }>('SieveScript/validate', { accountId, blobId })
      await b.send()
      const error = v.result.error
      return error ? (error.description ?? error.type) : null
    },

    async saveScript(edit: SieveScriptEdit) {
      const blobId = await upload(edit.content)
      const b = batch()
      const args: Record<string, unknown> = { accountId }
      if (edit.id) args['update'] = { [edit.id]: { name: edit.name, blobId } }
      else args['create'] = { s0: { name: edit.name, blobId } }
      // '#s0' is the creation reference; an existing script goes by its id.
      if (edit.activate) args['onSuccessActivateScript'] = edit.id ?? '#s0'
      const s = b.call<SetResponse<{ id: string }>>('SieveScript/set', args)
      await b.send()
      const r = s.result
      if (edit.id) {
        const err = r.notUpdated?.[edit.id]
        return { id: err ? null : edit.id, failure: err ? toFailure(err) : null }
      }
      const created = r.created?.['s0']
      if (created) return { id: created.id, failure: null }
      return { id: null, failure: toFailure(r.notCreated?.['s0']) }
    },

    /** `null` turns filtering off entirely rather than switching scripts. */
    async setActive(id: string | null): Promise<SetFailure | null> {
      const b = batch()
      const s = b.call<SetResponse<unknown>>('SieveScript/set', {
        accountId,
        ...(id === null ? { onSuccessDeactivateScript: true } : { onSuccessActivateScript: id }),
      })
      await b.send()
      const err = Object.values(s.result.notUpdated ?? {})[0]
      return err ? toFailure(err) : null
    },

    /** Refused while the script is the active one; deactivate it first. */
    async destroyScript(id: string): Promise<SetFailure | null> {
      const b = batch()
      const s = b.call<SetResponse<unknown>>('SieveScript/set', { accountId, destroy: [id] })
      await b.send()
      const err = s.result.notDestroyed?.[id]
      return err ? toFailure(err) : null
    },
  }
}
