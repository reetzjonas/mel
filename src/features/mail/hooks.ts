import Dexie from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { useUi } from '../../app/store'
import type { Account } from '../../domain/account'
import { matchesFilter, type EmailHeader, type MailFilter } from '../../domain/email'
import type { Mailbox } from '../../domain/mailbox'
import { db, type AccountScopedKey, type EmailRow } from '../../storage/db'
import { mailboxDateRange } from '../../storage/emailRow'
import { buildConversations, isHidden, type Conversation } from './conversations'
import { readThreadMembers, readThreadWindow } from './listIndex'
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

/**
 * The folders a conversation does not count: trash, junk and drafts.
 *
 * A message you deleted should not go on padding the row you deleted it from,
 * and an unsent draft is not part of the exchange yet — there is nothing in it
 * the other side has seen. Each is listed again in its own folder, where it is
 * the thing you came to look at, so the folder being listed is never excluded
 * from itself.
 */
export async function hiddenMailboxIds(
  accountId: string,
  mailboxId: string | undefined,
): Promise<Set<string>> {
  const roles = await Promise.all(
    (['trash', 'junk', 'drafts'] as const).map((role) =>
      db.mailboxes.where('[accountId+role]').equals([accountId, role]).primaryKeys(),
    ),
  )
  return new Set(
    roles
      .flat()
      .map((k) => k[1])
      .filter((id): id is string => Boolean(id) && id !== mailboxId),
  )
}

export interface MailboxList {
  /** Materialised headers, newest first — only the loaded window. Undefined
   *  while grouping is on; the list renders `conversations` instead. */
  emails: EmailHeader[] | undefined
  /** Conversation rows, newest first — only while grouping is on. */
  conversations: Conversation[] | undefined
  /*
   * Messages in the folder when listing messages — the real total, of which
   * only a window is materialised.
   *
   * Grouped, it is the conversations *found so far*, not the folder's total.
   * Counting the folder's distinct conversations would mean the account-wide
   * pass that the windowed read exists to avoid, and nothing renders this:
   * the virtual list runs on the rows it is given plus `loadMore`. It stays
   * because the message count is honest and free, and the tests read it.
   */
  total: number
  /** Materialise the next page; no-op once everything is loaded. */
  loadMore: () => void
}

/**
 * The messages of one mailbox, newest first, loaded a page at a time — either
 * one row per message or one per conversation (`grouped`).
 *
 * Two things this avoids, both of which made a 36k-message folder painful:
 *
 * 1. It never materialises the whole mailbox. Ordering comes from index-only
 *    reads (the account's date order intersected with the `*mailboxIds` index),
 *    which never touch a payload, and only the visible window is fetched with
 *    `bulkGet`. Measured on 20k messages: 1180ms to load the mailbox the old
 *    way, ~190ms for ordering plus the first hundred rows.
 *
 * 2. It is not a `useLiveQuery`. That observes the entire result set, so
 *    touching one row — exactly what markRead() does when you open an unread
 *    message — re-read, re-decrypted and re-sorted everything. Updates now
 *    arrive through Dexie's table hooks, which name the row that changed.
 *
 * Grouping keeps both properties: the account's thread index comes from the
 * same shared cache (`listIndex.ts`, scanned once and patched per changed row),
 * and only the threads in the window have their messages materialised.
 */
export function useMailboxEmails(
  accountId: string | undefined,
  mailboxId: string | undefined,
  filter?: MailFilter,
  grouped = false,
): MailboxList {
  const [state, setState] = useState<{
    emails: EmailHeader[] | undefined
    conversations: Conversation[] | undefined
    total: number
  }>({ emails: undefined, conversations: undefined, total: 0 })
  const more = useRef<() => void>(() => {})

  useEffect(() => {
    const empty = {
      emails: grouped ? undefined : [],
      conversations: grouped ? [] : undefined,
      total: 0,
    }
    setState({ emails: undefined, conversations: undefined, total: 0 })
    if (!accountId || !mailboxId) {
      setState(empty)
      return
    }

    const account = accountId
    const mailbox = mailboxId
    let cancelled = false
    let ready = false

    /** Ids of the mailbox, newest first. Cheap: strings, no payloads. */
    let order: string[] = []
    /** Thread ids of the mailbox, newest first — the row order when grouped. */
    let threadOrder: string[] = []
    /** threadId → every message of that thread, in any mailbox. */
    let members = new Map<string, string[]>()
    /** The threads currently rendered — what a changed row is checked against. */
    let visibleThreads = new Set<string>()
    /** Trash and junk, unless one of them is the mailbox being listed. */
    let excluded = new Set<string>()
    /** Headers fetched so far, by id. */
    const cache = new Map<string, EmailHeader>()
    let windowSize = PAGE
    /** Set once the folder has no further conversation to page in. */
    let exhausted = false

    /*
     * Ids matching the active flag filter, or null when nothing is filtered.
     *
     * An index scan rather than a predicate over the materialised window: a
     * folder can hold thousands of messages with a handful unread, and
     * filtering after paging would fill a page with almost nothing while the
     * rest of the folder never loads.
     */
    async function filterSet(): Promise<Set<string> | null> {
      if (!filter) return null
      const index = filter === 'unread' ? '[accountId+unread]' : '[accountId+flagged]'
      const keys = await db.emails.where(index).equals([account, 1]).primaryKeys()
      return new Set(keys.map((key) => key[1]))
    }

    /** Ordering straight from the indexes — no record bodies are read. */
    async function readOrder(): Promise<string[]> {
      // One prefix range over the derived `mailboxDates` index (emailRow.ts)
      // hands back this folder's ids already newest-first. It replaces reading
      // the account's whole date order and intersecting it with the folder —
      // work that scaled with the account, so an empty folder paid as much as
      // a 36k one, and paid it again on every sync write burst.
      const [from, to] = mailboxDateRange(mailbox)
      const [inMailbox, matches] = await Promise.all([
        db.emails.where('mailboxDates').between(from, to).primaryKeys(),
        filterSet(),
      ])
      const ids: string[] = []
      for (const key of inMailbox) {
        // The index key carries no account, and it is the primary key that
        // says which account a row belongs to. Mailbox ids are only unique
        // per account, so the check is what keeps a second account's folder
        // of the same id out of this one.
        if (key[0] !== account) continue
        const id = key[1]
        if (!matches || matches.has(id)) ids.push(id)
      }
      return ids
    }

    /** The ids the current window needs materialised. */
    function windowIds(): string[] {
      if (!grouped) return order.slice(0, windowSize)
      const ids: string[] = []
      for (const threadId of threadOrder.slice(0, windowSize)) {
        for (const id of members.get(threadId) ?? []) ids.push(id)
      }
      return ids
    }

    async function materialise() {
      const wanted = windowIds().filter((id) => !cache.has(id))
      if (wanted.length) {
        const rows = await db.emails.bulkGet(wanted.map((id) => [account, id] as AccountScopedKey))
        for (const row of rows) if (row) cache.set(row.id, openEnvelope(row.payload))
      }
    }

    function publish() {
      if (cancelled) return
      if (grouped) {
        const threadIds = threadOrder.slice(0, windowSize)
        visibleThreads = new Set(threadIds)
        setState({
          emails: undefined,
          conversations: buildConversations({
            threadIds,
            members,
            headers: cache,
            mailboxId: mailbox,
            filter,
            excludedMailboxIds: excluded,
          }),
          // Conversations loaded, not the folder's total — see MailboxList.
          total: threadOrder.length,
        })
        return
      }
      const emails: EmailHeader[] = []
      for (const id of order.slice(0, windowSize)) {
        const header = cache.get(id)
        // The header decides membership, not the index that produced `order`.
        // Rows are rendered from the header, so trusting the index here can
        // list a message that its own row says has moved away — it looks like
        // a move that did nothing, since everything about the row updates
        // except its presence.
        if (header && header.mailboxIds[mailbox] && matchesFilter(header, filter)) {
          emails.push(header)
        }
      }
      setState({ emails, conversations: undefined, total: order.length })
    }

    async function refresh() {
      if (grouped) {
        /*
         * Only the window is read: the conversations on screen, and then the
         * messages of those conversations. The folder's other 27,900 ids are
         * never touched, which is the whole difference to the account-wide
         * thread index this replaced.
         */
        const [matches, hidden] = await Promise.all([
          filterSet(),
          hiddenMailboxIds(account, mailbox),
        ])
        excluded = hidden
        const window = await readThreadWindow(
          account,
          mailbox,
          windowSize,
          matches ? (id) => matches.has(id) : undefined,
        )
        threadOrder = window.threadOrder
        exhausted = window.exhausted
        members = await readThreadMembers(account, threadOrder)
        // Grouped rendering never reads it, and filling it would mean the
        // folder-wide scan this exists to avoid.
        order = []
      } else {
        order = await readOrder()
      }
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
      if (!ready) return
      // Grouped paging has to go back to the index: the next conversations are
      // not in memory, because reading them was exactly what was skipped.
      if (grouped) {
        if (exhausted) return
        windowSize += PAGE
        void refresh()
        return
      }
      if (windowSize >= order.length) return
      windowSize += PAGE
      void materialise().then(publish)
    }

    /*
     * Table hooks see a row as the storage layer hands it on, which while
     * encryption is being switched on can be a sealed envelope this path has
     * no key for. Throwing here would abort the caller's write transaction —
     * that is how enabling encryption failed whenever a mailbox list happened
     * to be mounted. The row is not lost: the deferred re-read goes through
     * the decrypting read path after the commit.
     */
    function headerOf(row: EmailRow): EmailHeader | null {
      try {
        return openEnvelope(row.payload)
      } catch {
        return null
      }
    }

    function applyRow(row: EmailRow) {
      if (row.accountId !== account) return
      const header = headerOf(row)
      if (!header) {
        cache.delete(row.id)
        scheduleRefresh()
        return
      }
      // A filtered list is left by changing the flag too, not just the folder:
      // marking a message read under "unread only" has to drop it from the list
      // exactly the way moving it away would.
      const matches =
        filter === 'unread' ? row.unread === 1 : filter === 'flagged' ? row.flagged === 1 : true
      const belongs = row.mailboxIds.includes(mailbox) && matches
      const known = cache.has(row.id)

      if (grouped) {
        // A change outside the rendered threads only matters if it puts a
        // message into this mailbox — that is what can add or reorder a row.
        if (!visibleThreads.has(row.threadId)) {
          if (belongs) scheduleRefresh()
          return
        }
        const before = cache.get(row.id)
        const wasHere = before
          ? Boolean(before.mailboxIds[mailbox]) && matchesFilter(before, filter)
          : false
        cache.set(row.id, header)
        // A message joining or leaving the thread, or the mailbox, changes
        // which rows exist and in what order; anything else (read, flagged) is
        // a repaint of a row that stays put.
        if (!known || wasHere !== belongs) scheduleRefresh()
        else if (ready) publish()
        return
      }

      const position = order.indexOf(row.id)
      // Membership or arrival changes the ordering, so it has to be re-derived
      // — index-only, and the cache keeps already-fetched headers.
      if (belongs !== (position !== -1)) {
        if (belongs) cache.set(row.id, header)
        else cache.delete(row.id)
        scheduleRefresh()
        return
      }
      // Same position, changed contents (read, flagged …): patch in place.
      if (belongs && known) {
        cache.set(row.id, header)
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
      const listed = grouped ? visibleThreads.has(row.threadId) : order.includes(row.id)
      if (listed) scheduleRefresh()
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
  }, [accountId, mailboxId, filter, grouped])

  return {
    emails: state.emails,
    conversations: state.conversations,
    total: state.total,
    loadMore: () => more.current(),
  }
}

/**
 * Every message of one thread, oldest first — the reading pane's conversation.
 *
 * A `useLiveQuery` is fine here where it was not for the mailbox list: a thread
 * is a handful of rows, and the pane has to notice a reply arriving.
 */
export function useThread(
  accountId: string | undefined,
  threadId: string | undefined,
  mailboxId: string | undefined,
): EmailHeader[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId || !threadId) return []
    const [rows, hidden] = await Promise.all([
      db.emails.where('[accountId+threadId]').equals([accountId, threadId]).toArray(),
      hiddenMailboxIds(accountId, mailboxId),
    ])
    // The same messages the list row counted, or the pane would say "10
    // messages" over a stack of twelve.
    return rows
      .map((r) => openEnvelope(r.payload))
      .filter((h) => !isHidden(h, hidden))
      .sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0))
  }, [accountId, threadId, mailboxId])
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
