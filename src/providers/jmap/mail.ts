import type { EmailHeader } from '../../domain/email'
import type { Mailbox } from '../../domain/mailbox'
import { CannotCalculateChanges, type MailProvider, type SyncPage } from '../types'
import { Batch, chunkIds } from './client/request'
import type { Transport } from './client/transport'
import { Cap, type ChangesResponse, type CoreCapability, type GetResponse, type QueryResponse } from './client/types/core'
import {
  EMAIL_BODY_PROPS,
  EMAIL_HEADER_PROPS,
  type JmapEmail,
  type JmapMailbox,
} from './client/types/mail'
import { toEmailBody, toEmailHeader, toMailbox } from './mappers/mail'

const USING = [Cap.core, Cap.mail]
const MAX_CHANGES = 256
const QUERY_PAGE = 200

export function createJmapMail(
  transport: Transport,
  accountId: string,
  limits: CoreCapability,
): MailProvider {
  const batch = () => new Batch(transport, USING)

  async function changesWithGet<TJmap, TOut>(
    type: 'Mailbox' | 'Email',
    sinceState: string,
    properties: readonly string[],
    map: (v: TJmap) => TOut,
  ): Promise<SyncPage<TOut>> {
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

  return {
    async syncMailboxes(sinceState) {
      if (!sinceState) {
        const b = batch()
        const get = b.call<GetResponse<JmapMailbox>>('Mailbox/get', { accountId, ids: null })
        await b.send()
        const r = get.result
        return {
          created: r.list.map(toMailbox),
          updated: [],
          destroyedIds: [],
          newState: r.state,
          hasMore: false,
        }
      }
      return changesWithGet<JmapMailbox, Mailbox>('Mailbox', sinceState, [], toMailbox)
    },

    async syncEmailHeaders(sinceState) {
      return changesWithGet<JmapEmail, EmailHeader>(
        'Email',
        sinceState,
        EMAIL_HEADER_PROPS,
        toEmailHeader,
      )
    },

    async listAllEmailHeaders(onPage) {
      let position = 0
      let state = ''
      for (;;) {
        const b = batch()
        const q = b.call<QueryResponse>('Email/query', {
          accountId,
          sort: [{ property: 'receivedAt', isAscending: false }],
          position,
          limit: QUERY_PAGE,
        })
        const g = b.call<GetResponse<JmapEmail>>('Email/get', {
          accountId,
          '#ids': q.ref('/ids'),
          properties: EMAIL_HEADER_PROPS,
        })
        // Email state token for subsequent /changes (query state is separate).
        const st = b.call<GetResponse<JmapEmail>>('Email/get', { accountId, ids: [] })
        await b.send()
        state = st.result.state
        const headers = g.result.list.map(toEmailHeader)
        await onPage({ headers, state })
        if (q.result.ids.length < QUERY_PAGE) return state
        position += QUERY_PAGE
      }
    },

    async getEmailHeaders(ids) {
      const out: EmailHeader[] = []
      for (const chunk of chunkIds(ids, limits.maxObjectsInGet)) {
        const b = batch()
        const g = b.call<GetResponse<JmapEmail>>('Email/get', {
          accountId,
          ids: chunk,
          properties: EMAIL_HEADER_PROPS,
        })
        await b.send()
        out.push(...g.result.list.map(toEmailHeader))
      }
      return out
    },

    async getEmailBody(id) {
      const b = batch()
      const g = b.call<GetResponse<JmapEmail>>('Email/get', {
        accountId,
        ids: [id],
        properties: EMAIL_BODY_PROPS,
        fetchAllBodyValues: true,
      })
      await b.send()
      const e = g.result.list[0]
      return e ? toEmailBody(e) : null
    },
  }
}
