import { CannotCalculateChanges, type SyncPage } from '../types'
import type { Batch } from './client/request'
import { JmapError } from './client/transport'
import type { ChangesResponse, GetResponse, QueryResponse } from './client/types/core'

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
  /**
   * The server's maxObjectsInGet: the page size when a full fetch has to be
   * paged through `/query` instead (see `fetchAll`).
   */
  pageSize?: number | undefined
}

/** The session's own default for maxObjectsInGet, where no limit was passed. */
const DEFAULT_PAGE_SIZE = 500

/** Starting the paged fetch over at most this often before giving up. */
const MAX_RESTARTS = 3

/**
 * Everything in the collection, reported as created.
 *
 * With no state there is nothing to diff against, so the whole list *is* what
 * changed. `ids: null` means "all of them" — an empty array would mean none.
 *
 * A server answers that with `requestTooLarge` once the collection holds more
 * than its maxObjectsInGet (RFC 8620 S5.1) — a calendar of a few thousand
 * events is enough — so then the collection is paged through `/query` instead.
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
  if (get.error?.type === 'requestTooLarge') return fetchAllPaged(batch, spec)
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
 * The whole collection a page at a time: `/query` for a page of ids and a
 * `/get` of them by back-reference, one request per page.
 *
 * The state handed back is the first page's, so anything that changes while
 * paging is fetched again by the next delta rather than lost. What a delta
 * cannot catch is an object that never changed but moved to a page already
 * read, because something before it went: so a queryState that moves between
 * pages starts the fetch over.
 */
async function fetchAllPaged<TJmap, TOut>(
  batch: () => Batch,
  spec: CollectionSpec<TJmap, TOut>,
): Promise<SyncPage<TOut>> {
  const { type, accountId, properties, map } = spec
  const pageSize =
    spec.pageSize !== undefined && spec.pageSize > 0 ? spec.pageSize : DEFAULT_PAGE_SIZE
  for (let attempt = 0; attempt <= MAX_RESTARTS; attempt++) {
    const created: TOut[] = []
    let newState: string | undefined
    let queryState: string | undefined
    let position = 0
    let restart = false
    for (;;) {
      const b = batch()
      const q = b.call<QueryResponse>(`${type}/query`, { accountId, position, limit: pageSize })
      const g = b.call<GetResponse<TJmap>>(`${type}/get`, {
        accountId,
        '#ids': q.ref('/ids'),
        properties,
      })
      await b.send()
      const page = q.result
      if (queryState === undefined) queryState = page.queryState
      else if (page.queryState !== queryState) {
        restart = true
        break
      }
      const got = g.result
      newState ??= got.state
      created.push(...got.list.map(map))
      // A server may cap `limit` below what was asked; only an empty page
      // says for certain that there is nothing further.
      if (page.ids.length === 0) break
      position += page.ids.length
      if (page.total !== undefined && position >= page.total) break
    }
    if (!restart) {
      return { created, updated: [], destroyedIds: [], newState: newState ?? '', hasMore: false }
    }
  }
  throw new JmapError(
    `${type}/query: the collection kept changing while it was fetched`,
    'protocol',
  )
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
