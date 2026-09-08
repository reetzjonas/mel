import Dexie from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { useUi } from '../../app/store'
import type { Account } from '../../domain/account'
import type { EmailHeader } from '../../domain/email'
import type { Mailbox } from '../../domain/mailbox'
import { db, type AccountScopedKey, type EmailRow } from '../../storage/db'
import { openEnvelope } from '../../storage/envelope'

export function useAccounts() {
  const unlockVersion = useUi((s) => s.unlockVersion)
  return useLiveQuery(async () => {
    const rows = await db.accounts.toArray()
    const out: Account[] = []
    for (const r of rows) {
      try {
        out.push(openEnvelope(r.payload).account)
      } catch {
        // Sealed (locked) account — the UnlockGate handles it.
      }
    }
    return out
  }, [unlockVersion])
}

const ROLE_ORDER: Record<string, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  junk: 4,
  trash: 5,
}

export function useMailboxes(accountId: string | undefined): Mailbox[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId) return []
    const rows = await db.mailboxes.where('accountId').equals(accountId).toArray()
    return rows
      .map((r) => openEnvelope(r.payload))
      .sort(
        (a, b) =>
          (ROLE_ORDER[a.role ?? ''] ?? 9) - (ROLE_ORDER[b.role ?? ''] ?? 9) ||
          a.sortOrder - b.sortOrder ||
          a.name.localeCompare(b.name),
      )
  }, [accountId])
}

/** How many messages are materialised at a time. */
const PAGE = 100

export interface MailboxList {
  /** Materialised headers, newest first — only the loaded window. */
  emails: EmailHeader[] | undefined
  /** How many messages the mailbox holds in total. */
  total: number
  /** Materialise the next page; no-op once everything is loaded. */
  loadMore: () => void
}

/**
 * The messages of one mailbox, newest first, loaded a page at a time.
 *
 * Two things this avoids, both of which made a 36k-message folder painful:
 *
 * 1. It never materialises the whole mailbox. Ordering comes from index-only
 *    reads (`primaryKeys()` over `[accountId+receivedAt]` intersected with the
 *    `*mailboxIds` index), which never touch a payload, and only the visible
 *    window is fetched with `bulkGet`. Measured on 20k messages: 1180ms to load
 *    the mailbox the old way, ~190ms for ordering plus the first hundred rows.
 *
 * 2. It is not a `useLiveQuery`. That observes the entire result set, so
 *    touching one row — exactly what markRead() does when you open an unread
 *    message — re-read, re-decrypted and re-sorted everything. Updates now
 *    arrive through Dexie's table hooks, which name the row that changed.
 */
export function useMailboxEmails(
  accountId: string | undefined,
  mailboxId: string | undefined,
): MailboxList {
  const [state, setState] = useState<{ emails: EmailHeader[] | undefined; total: number }>({
    emails: undefined,
    total: 0,
  })
  const more = useRef<() => void>(() => {})

  useEffect(() => {
    setState({ emails: undefined, total: 0 })
    if (!accountId || !mailboxId) {
      setState({ emails: [], total: 0 })
      return
    }

    const account = accountId
    const mailbox = mailboxId
    let cancelled = false
    let ready = false

    /** Ids of the mailbox, newest first. Cheap: strings, no payloads. */
    let order: string[] = []
    /** Headers fetched so far, by id. */
    const cache = new Map<string, EmailHeader>()
    let windowSize = PAGE

    /** Ordering straight from the indexes — no record bodies are read. */
    async function readOrder(): Promise<string[]> {
      const [byDate, inMailbox] = await Promise.all([
        db.emails
          .where('[accountId+receivedAt]')
          .between([account, -Infinity], [account, Infinity])
          .reverse()
          .primaryKeys(),
        db.emails.where('mailboxIds').equals(mailbox).primaryKeys(),
      ])
      const members = new Set(inMailbox.map((k) => k[1]))
      return byDate.map((k) => k[1]).filter((id) => members.has(id))
    }

    async function materialise() {
      const wanted = order.slice(0, windowSize).filter((id) => !cache.has(id))
      if (wanted.length) {
        const rows = await db.emails.bulkGet(wanted.map((id) => [account, id] as AccountScopedKey))
        for (const row of rows) if (row) cache.set(row.id, openEnvelope(row.payload))
      }
    }

    function publish() {
      if (cancelled) return
      const emails: EmailHeader[] = []
      for (const id of order.slice(0, windowSize)) {
        const header = cache.get(id)
        if (header) emails.push(header)
      }
      setState({ emails, total: order.length })
    }

    async function refresh() {
      order = await readOrder()
      await materialise()
      publish()
    }

    /*
     * Table hooks fire *inside* the write transaction, where a fresh read
     * cannot see the row being written yet. Deferring to a macrotask puts the
     * re-read after the commit — and coalesces bursts, so a sync writing a
     * page of 200 messages costs one re-read rather than two hundred.
     */
    let refreshQueued = false
    function scheduleRefresh() {
      if (refreshQueued || !ready) return
      refreshQueued = true
      setTimeout(() => {
        refreshQueued = false
        if (!cancelled) void refresh()
      }, 0)
    }

    more.current = () => {
      if (!ready || windowSize >= order.length) return
      windowSize += PAGE
      void materialise().then(publish)
    }

    function applyRow(row: EmailRow) {
      if (row.accountId !== account) return
      const known = cache.has(row.id)
      const position = order.indexOf(row.id)
      const belongs = row.mailboxIds.includes(mailbox)

      // Membership or arrival changes the ordering, so it has to be re-derived
      // — index-only, and the cache keeps already-fetched headers.
      if (belongs !== (position !== -1)) {
        if (belongs) cache.set(row.id, openEnvelope(row.payload))
        else cache.delete(row.id)
        scheduleRefresh()
        return
      }
      // Same position, changed contents (read, flagged …): patch in place.
      if (belongs && known) {
        cache.set(row.id, openEnvelope(row.payload))
        if (ready) publish()
      }
    }

    const onCreating = (_key: AccountScopedKey, row: EmailRow) => applyRow(row)

    const onUpdating = (mods: object, _key: AccountScopedKey, row: EmailRow) => {
      // Dexie hands over a *deep* diff keyed by dotted paths
      // ("payload.plain.keywords.$seen"), not a shallow object to spread.
      const next = structuredClone(row)
      for (const [path, value] of Object.entries(mods)) Dexie.setByKeyPath(next, path, value)
      applyRow(next)
    }

    const onDeleting = (_key: AccountScopedKey, row: EmailRow) => {
      if (!row || row.accountId !== account) return
      cache.delete(row.id)
      if (order.includes(row.id)) scheduleRefresh()
    }

    db.emails.hook('creating', onCreating)
    db.emails.hook('updating', onUpdating)
    db.emails.hook('deleting', onDeleting)

    void refresh().then(() => {
      ready = true
    })

    return () => {
      cancelled = true
      db.emails.hook('creating').unsubscribe(onCreating)
      db.emails.hook('updating').unsubscribe(onUpdating)
      db.emails.hook('deleting').unsubscribe(onDeleting)
    }
  }, [accountId, mailboxId])

  return { emails: state.emails, total: state.total, loadMore: () => more.current() }
}

export function useEmail(
  accountId: string | undefined,
  emailId: string | undefined,
): EmailHeader | null | undefined {
  return useLiveQuery(async () => {
    if (!accountId || !emailId) return null
    const row = await db.emails.get([accountId, emailId])
    return row ? openEnvelope(row.payload) : null
  }, [accountId, emailId])
}
