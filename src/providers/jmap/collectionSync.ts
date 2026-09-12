import { CannotCalculateChanges, type SyncPage } from '../types'
import type { Batch } from './client/request'
import type { ChangesResponse, GetResponse } from './client/types/core'

/**
 * Syncing one JMAP collection, in the two shapes RFC 8620 gives us.
 *
 * Mailboxes, address books, contact cards, calendars and events all sync the
 * same way, and each provider used to carry its own copy of it — three near
 * identical functions that had already begun to drift (only mail's passed
 * `properties`, so a collection that later needed them would have fetched
 * whole objects without anyone noticing). Each also carried its own
 * `MAX_CHANGES = 256`.
 *
 * The batch is passed in rather than built here: `using` differs per
 * collection, and claiming a capability the server does not have is refused
 * outright.
 */

/** How many changes to ask for at once; the caller loops on `hasMore`. */
const MAX_CHANGES = 256

export interface CollectionSpec<TJmap, TOut> {
  /** The JMAP object type, e.g. 'ContactCard'. */
  type: string
  accountId: string
  /**
   * Properties to fetch, or undefined for all of them.
   *
   * Not the same as an empty array, which asks for `id` alone — a delta that
   * fetched only ids would store rows with no contents at all.
   */
  properties?: readonly string[] | undefined
  /** Wire shape to the domain object stored locally. */
  map: (v: TJmap) => TOut
}

/**
 * Everything in the collection, reported as created.
 *
 * With no state there is nothing to diff against, so the whole list *is* what
 * changed. `ids: null` means "all of them" — an empty array would mean none.
 */
export async function fetchAll<TJmap, TOut>(
  batch: () => Batch,
  spec: CollectionSpec<TJmap, TOut>,
): Promise<SyncPage<TOut>> {
  const b = batch()
  const get = b.call<GetResponse<TJmap>>(`${spec.type}/get`, {
    accountId: spec.accountId,
    ids: null,
    properties: spec.properties,
  })
  await b.send()
  const r = get.result
  return {
    created: r.list.map(spec.map),
    updated: [],
    destroyedIds: [],
    newState: r.state,
    hasMore: false,
  }
}

/**
 * What changed since `sinceState`, in a single request.
 *
 * The two gets feed off the changes call by back-reference, so this is one
 * round trip rather than three — the request storm on first login was exactly
 * this going wrong.
 *
 * A state the server has forgotten is raised as `CannotCalculateChanges`
 * rather than a generic error: the engine catches precisely that to fall back
 * to a full fetch, and anything else would be retried against a state that is
 * never coming back.
 */
export async function fetchChanges<TJmap, TOut>(
  batch: () => Batch,
  spec: CollectionSpec<TJmap, TOut>,
  sinceState: string,
): Promise<SyncPage<TOut>> {
  const { type, accountId, properties, map } = spec
  const b = batch()
  const ch = b.call<ChangesResponse>(`${type}/changes`, {
    accountId,
    sinceState,
    maxChanges: MAX_CHANGES,
  })
  const created = b.call<GetResponse<TJmap>>(`${type}/get`, {
    accountId,
    '#ids': ch.ref('/created'),
    properties,
  })
  const updated = b.call<GetResponse<TJmap>>(`${type}/get`, {
    accountId,
    '#ids': ch.ref('/updated'),
    properties,
  })
  await b.send()
  if (ch.error?.type === 'cannotCalculateChanges') throw new CannotCalculateChanges()
  const changes = ch.result
  return {
    created: created.result.list.map(map),
    updated: updated.result.list.map(map),
    destroyedIds: changes.destroyed,
    newState: changes.newState,
    hasMore: changes.hasMoreChanges,
  }
}

/** A full fetch the first time, a delta afterwards. */
export function syncCollection<TJmap, TOut>(
  batch: () => Batch,
  spec: CollectionSpec<TJmap, TOut>,
  sinceState: string | undefined,
): Promise<SyncPage<TOut>> {
  return sinceState ? fetchChanges(batch, spec, sinceState) : fetchAll(batch, spec)
}
