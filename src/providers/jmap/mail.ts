import { Keyword, type EmailHeader } from '../../domain/email'
import type { Identity } from '../../domain/identity'
import type { Mailbox } from '../../domain/mailbox'
import { isGroup, type SearchQuery } from '../../domain/search'
import {
  CannotCalculateChanges,
  type MailProvider,
  type SetFailure,
  type SetOutcome,
  type SyncPage,
} from '../types'
import { Batch, chunkIds } from './client/request'
import type { Transport } from './client/transport'
import {
  Cap,
  type ChangesResponse,
  type CoreCapability,
  type GetResponse,
  type QueryResponse,
  type SetError,
  type SetResponse,
} from './client/types/core'
import {
  EMAIL_BODY_PROPS,
  EMAIL_HEADER_PROPS,
  type EmailFilter,
  type JmapEmail,
  type JmapMailbox,
} from './client/types/mail'
import { toEmailBody, toEmailHeader, toMailbox } from './mappers/mail'

const USING = [Cap.core, Cap.mail]
const USING_SUBMIT = [Cap.core, Cap.mail, Cap.submission]
const MAX_CHANGES = 256
/** Page size when walking a whole mailbox for a bulk selection. */
const BULK_QUERY_PAGE = 1000

/** Set-error types that will not succeed on retry. */
const PERMANENT_SET_ERRORS = new Set([
  'invalidProperties',
  'invalidPatch',
  'notFound',
  'forbidden',
  'overQuota',
  'tooLarge',
  'singleton',
])

function toFailure(e: SetError | undefined): SetFailure {
  return {
    type: e?.type ?? 'serverFail',
    description: e?.description,
    permanent: e ? PERMANENT_SET_ERRORS.has(e.type) : false,
  }
}

export function jmapSearchFilter(q: SearchQuery, mailboxId?: string): EmailFilter {
  const mapped = mapQuery(q)
  if (mailboxId) return { operator: 'AND', conditions: [{ inMailbox: mailboxId }, mapped] }
  return mapped
}

function mapQuery(q: SearchQuery): EmailFilter {
  if (isGroup(q)) {
    return { operator: q.op, conditions: q.children.map(mapQuery) }
  }
  const conds: EmailFilter[] = []
  if (q.text) conds.push({ text: q.text })
  if (q.from) conds.push({ from: q.from })
  if (q.to) conds.push({ to: q.to })
  if (q.subject) conds.push({ subject: q.subject })
  if (q.hasAttachment !== undefined) conds.push({ hasAttachment: q.hasAttachment })
  if (q.isUnread !== undefined)
    conds.push(q.isUnread ? { notKeyword: '$seen' } : { hasKeyword: '$seen' })
  if (q.isFlagged) conds.push({ hasKeyword: '$flagged' })
  if (q.before) conds.push({ before: `${q.before}T00:00:00Z` })
  if (q.after) conds.push({ after: `${q.after}T00:00:00Z` })
  if (conds.length === 0) return {}
  if (conds.length === 1) return conds[0]!
  return { operator: 'AND', conditions: conds }
}

/** JSON Email object for a draft (text/html bodies, no submission). */
function buildDraftObject(
  mail: import('../../domain/identity').OutgoingEmail,
  draftsMailboxId: string,
): Record<string, unknown> {
  return {
    mailboxIds: { [draftsMailboxId]: true },
    keywords: { $seen: true, $draft: true },
    from: [mail.from],
    to: mail.to.length ? mail.to : undefined,
    cc: mail.cc.length ? mail.cc : undefined,
    bcc: mail.bcc.length ? mail.bcc : undefined,
    subject: mail.subject,
    inReplyTo: mail.inReplyTo ?? undefined,
    references: mail.references ?? undefined,
    bodyValues: { t: { value: mail.text }, h: { value: mail.html } },
    textBody: [{ partId: 't', type: 'text/plain' }],
    htmlBody: [{ partId: 'h', type: 'text/html' }],
  }
}

export function createJmapMail(
  transport: Transport,
  accountId: string,
  limits: CoreCapability,
  uploadUrl: string,
  downloadUrl: string,
): MailProvider {
  const batch = () => new Batch(transport, USING)

  async function changesWithGet<TJmap, TOut>(
    type: 'Mailbox' | 'Email',
    sinceState: string,
    // undefined → all properties; an empty array would mean "only id"!
    properties: readonly string[] | undefined,
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
      return changesWithGet<JmapMailbox, Mailbox>('Mailbox', sinceState, undefined, toMailbox)
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
      // Page by the server's own Email/get ceiling rather than a fixed guess:
      // the ids this fetches immediately feed an Email/get for the same page,
      // so a page smaller than what the server allows only adds request
      // round-trips without saving anything. A hardcoded 200 here against a
      // server permitting far more (some report 1000+) was exactly the "many
      // small requests instead of few large ones" shape behind the reported
      // request storm on first login with a large mailbox.
      const pageSize = limits.maxObjectsInGet
      let position = 0
      let state = ''
      for (;;) {
        const b = batch()
        const q = b.call<QueryResponse>('Email/query', {
          accountId,
          sort: [{ property: 'receivedAt', isAscending: false }],
          position,
          limit: pageSize,
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
        if (q.result.ids.length < pageSize) return state
        // Must advance by exactly the page size that was requested above.
        position += pageSize
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

    async setEmails(updates, destroy) {
      // Bulk actions can span a whole mailbox, which blows past
      // maxObjectsInSet (500 on Stalwart) in a single Email/set. Chunk both
      // sides and merge the outcomes.
      const ids = Object.keys(updates)
      const max = limits.maxObjectsInSet
      const updateChunks = ids.length ? chunkIds(ids, max) : []
      const destroyChunks = destroy.length ? chunkIds(destroy, max) : []
      const rounds = Math.max(updateChunks.length, destroyChunks.length, 1)

      const outcome: SetOutcome = { updated: [], destroyed: [], failed: {} }
      for (let i = 0; i < rounds; i++) {
        const chunk = updateChunks[i]
        const toDestroy = destroyChunks[i]
        if (!chunk && !toDestroy) break
        const patch: Record<string, Record<string, unknown>> = {}
        for (const id of chunk ?? []) patch[id] = updates[id]!
        const b = batch()
        const s = b.call<SetResponse<JmapEmail>>('Email/set', {
          accountId,
          update: chunk?.length ? patch : undefined,
          destroy: toDestroy?.length ? toDestroy : undefined,
        })
        await b.send()
        const r = s.result
        outcome.updated.push(...Object.keys(r.updated ?? {}))
        outcome.destroyed.push(...(r.destroyed ?? []))
        for (const [id, err] of Object.entries({ ...r.notUpdated, ...r.notDestroyed }))
          outcome.failed[id] = toFailure(err)
      }
      // An id the server acknowledged in neither direction was not applied.
      // Calling that success loses the change silently while the UI shows it
      // worked; treating it as transient makes the outbox retry and surface it.
      for (const id of ids) {
        if (!outcome.updated.includes(id) && !outcome.failed[id]) {
          outcome.failed[id] = { type: 'notApplied', permanent: false }
        }
      }
      return outcome
    },

    /**
     * Every id in a mailbox, server-side — a bulk "select all" must not rely on
     * whatever happens to be cached locally. Pages until the mailbox is
     * exhausted or `limit` is reached, and reports the server's own total so
     * the caller can say when it stopped short instead of silently truncating.
     */
    async queryMailboxIds(mailboxId, limit, view) {
      // Server-side, so "everything in this folder" under a filter cannot
      // select messages the filtered list is not showing.
      const filter = {
        inMailbox: mailboxId,
        ...(view === 'unread' ? { notKeyword: Keyword.seen } : {}),
        ...(view === 'flagged' ? { hasKeyword: Keyword.flagged } : {}),
      }
      const sort = [{ property: 'receivedAt', isAscending: false }]
      const ids: string[] = []
      let total = 0
      for (let position = 0; position < limit; position += BULK_QUERY_PAGE) {
        const b = batch()
        const q = b.call<QueryResponse & { total?: number }>('Email/query', {
          accountId,
          filter,
          sort,
          position,
          limit: Math.min(BULK_QUERY_PAGE, limit - position),
          calculateTotal: true,
        })
        await b.send()
        const page = q.result
        if (page.total !== undefined) total = page.total
        ids.push(...page.ids)
        if (!page.ids.length || ids.length >= total) break
      }
      return { ids, total: total || ids.length }
    },

    async editMailbox(edit) {
      const b = batch()
      const s = b.call<SetResponse<JmapMailbox>>('Mailbox/set', {
        accountId,
        create: edit.create ? { m0: edit.create } : undefined,
        update: edit.update ? { [edit.update.id]: { ...edit.update, id: undefined } } : undefined,
        destroy: edit.destroy ? [edit.destroy] : undefined,
        onDestroyRemoveEmails: edit.destroyWithEmails ?? false,
      })
      await b.send()
      const r = s.result
      if (edit.create) {
        const created = r.created?.['m0']
        return created
          ? { id: created.id, failure: null }
          : { id: null, failure: toFailure(r.notCreated?.['m0']) }
      }
      const key = edit.update?.id ?? edit.destroy ?? ''
      const err = r.notUpdated?.[key] ?? r.notDestroyed?.[key]
      return { id: key, failure: err ? toFailure(err) : null }
    },

    async identities() {
      const b = new Batch(transport, USING_SUBMIT)
      const g = b.call<
        GetResponse<{ id: string; name: string; email: string; replyTo: Identity['replyTo'] }>
      >('Identity/get', { accountId, ids: null })
      await b.send()
      return g.result.list.map((i) => ({
        id: i.id,
        name: i.name ?? '',
        email: i.email,
        replyTo: i.replyTo ?? null,
      }))
    },

    async uploadBlob(data, type) {
      const url = uploadUrl.replace('{accountId}', encodeURIComponent(accountId))
      const res = await transport.fetchRaw(url, {
        method: 'POST',
        headers: { 'Content-Type': type || 'application/octet-stream' },
        body: data,
      })
      const j = (await res.json()) as { blobId: string; size: number }
      return { blobId: j.blobId, size: j.size }
    },

    async saveDraft(mail, draftsMailboxId, replaceId) {
      const b = new Batch(transport, USING)
      const s = b.call<SetResponse<{ id: string }>>('Email/set', {
        accountId,
        create: { draft: buildDraftObject(mail, draftsMailboxId) },
        destroy: replaceId ? [replaceId] : undefined,
      })
      await b.send()
      return s.result.created?.['draft']?.id ?? null
    },

    async sendEmail(mail, mailboxIds) {
      const create: Record<string, unknown> = {
        mailboxIds: { [mailboxIds.drafts]: true },
        keywords: { $seen: true, $draft: true },
        from: [mail.from],
        to: mail.to.length ? mail.to : undefined,
        cc: mail.cc.length ? mail.cc : undefined,
        bcc: mail.bcc.length ? mail.bcc : undefined,
        subject: mail.subject,
        inReplyTo: mail.inReplyTo ?? undefined,
        references: mail.references ?? undefined,
        bodyValues: {
          t: { value: mail.text },
          h: { value: mail.html },
        },
        textBody: [{ partId: 't', type: 'text/plain' }],
        htmlBody: [{ partId: 'h', type: 'text/html' }],
        attachments: mail.attachments.length
          ? mail.attachments.map((a) => ({
              blobId: a.blobId,
              type: a.type,
              name: a.name,
              disposition: 'attachment',
            }))
          : undefined,
      }
      const b = new Batch(transport, USING_SUBMIT)
      const setCall = b.call<SetResponse<JmapEmail>>('Email/set', {
        accountId,
        create: { draft: create },
      })
      const submit = b.call<SetResponse<unknown>>('EmailSubmission/set', {
        accountId,
        create: {
          sub: { emailId: '#draft', identityId: mail.identityId },
        },
        onSuccessUpdateEmail: {
          '#sub': {
            [`mailboxIds/${mailboxIds.drafts}`]: null,
            [`mailboxIds/${mailboxIds.sent}`]: true,
            'keywords/$draft': null,
          },
        },
      })
      await b.send()
      const notCreated = setCall.result.notCreated?.['draft'] ?? submit.result.notCreated?.['sub']
      if (notCreated) {
        const f = toFailure(notCreated)
        const err = new Error(`${f.type}${f.description ? `: ${f.description}` : ''}`)
        ;(err as Error & { permanent?: boolean }).permanent = f.permanent
        throw err
      }
    },

    async searchEmails(query, opts) {
      const filter = jmapSearchFilter(query, opts.mailboxId)
      const b = batch()
      const q = b.call<QueryResponse>('Email/query', {
        accountId,
        filter,
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: opts.limit ?? 50,
      })
      const sn = b.call<{
        list: Array<{ emailId: string; subject: string | null; preview: string | null }>
      }>('SearchSnippet/get', { accountId, filter, '#emailIds': q.ref('/ids') })
      await b.send()
      const snippets: Record<string, { subject: string | null; preview: string | null }> = {}
      if (!sn.error) {
        for (const s of sn.result.list)
          snippets[s.emailId] = { subject: s.subject, preview: s.preview }
      }
      return { ids: q.result.ids, snippets }
    },

    async getVacation() {
      const b = new Batch(transport, [Cap.core, Cap.mail, Cap.vacation])
      const g = b.call<
        GetResponse<{ isEnabled: boolean; subject: string | null; textBody: string | null }>
      >('VacationResponse/get', { accountId })
      await b.send()
      const v = g.result.list[0]
      return {
        enabled: v?.isEnabled ?? false,
        subject: v?.subject ?? '',
        text: v?.textBody ?? '',
      }
    },

    async downloadBlob(blobId, type, name) {
      const url = downloadUrl
        .replace('{accountId}', encodeURIComponent(accountId))
        .replace('{blobId}', encodeURIComponent(blobId))
        .replace('{type}', encodeURIComponent(type))
        .replace('{name}', encodeURIComponent(name))
      const res = await transport.fetchRaw(url)
      return res.blob()
    },

    async setVacation(v) {
      const b = new Batch(transport, [Cap.core, Cap.mail, Cap.vacation])
      const s = b.call<SetResponse<unknown>>('VacationResponse/set', {
        accountId,
        update: {
          singleton: {
            isEnabled: v.enabled,
            subject: v.subject || null,
            textBody: v.text || null,
          },
        },
      })
      await b.send()
      const err = s.result.notUpdated?.['singleton']
      if (err) throw new Error(err.description ?? err.type)
    },
  }
}
