import { Outlet, createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { matchesFilter, type MailFilter } from '../../domain/email'
import { InitialSync } from '../../features/mail/InitialSync'
import { ResizeHandle } from '../../features/mail/ResizeHandle'
import { PANEL_WIDTH_VAR, usePanelWidth } from '../../features/mail/panelWidths'
import { SelectionToolbar } from '../../features/mail/SelectionToolbar'
import { ThreadList } from '../../features/mail/ThreadList'
import {
  useAccounts,
  useFullSyncProgress,
  useMailboxEmails,
  useMailboxes,
} from '../../features/mail/hooks'
import { useUi } from '../store'
import { t } from '../../lib/i18n'
import { searchEmails, type SearchResult } from '../../services/search'
import { syncAccount } from '../../sync/engine'
import { EmptyState } from '../../ui/EmptyState'
import { Icon, type IconName } from '../../ui/Icon'
import { Tooltip } from '../../ui/Tooltip'
import { ThreadListSkeleton } from '../../ui/Skeleton'

export const Route = createFileRoute('/mail/$mailboxId')({
  component: MailboxView,
  validateSearch: (s: Record<string, unknown>): { q?: string; filter?: MailFilter } => ({
    q: typeof s['q'] === 'string' && s['q'] ? s['q'] : undefined,
    filter: s['filter'] === 'unread' || s['filter'] === 'flagged' ? s['filter'] : undefined,
  }),
})

function FilterToggle({
  icon,
  label,
  active,
  onClick,
}: {
  icon: IconName
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <Tooltip label={active ? t('mail.filter.showAll') : label}>
      <button
        type="button"
        aria-pressed={active}
        aria-label={label}
        onClick={onClick}
        /*
         * Filled rather than washed when on: this is a persistent mode that
         * changes what the whole list contains, and a tinted chip beside a grey
         * one is far too close a call to read at this size. Same treatment the
         * active app-switcher item uses.
         */
        className={`shrink-0 rounded-control p-2 transition-colors ${
          active
            ? 'bg-accent text-accent-ink hover:bg-accent-hover'
            : 'bg-surface-2 text-ink-subtle hover:text-ink'
        }`}
      >
        <Icon name={icon} size={14} />
      </button>
    </Tooltip>
  )
}

function MailboxView() {
  const { mailboxId } = Route.useParams()
  const { q, filter } = Route.useSearch()
  const params = useParams({ strict: false }) as { emailId?: string }
  const navigate = useNavigate()
  const accounts = useAccounts()
  const account = accounts?.[0]
  const accountId = account?.id
  const grouped = useUi((s) => s.conversationView)
  const mailbox = useMailboxEmails(accountId, mailboxId, filter, grouped)
  const fullSync = useFullSyncProgress(accountId)
  const [results, setResults] = useState<SearchResult | null>(null)
  const [input, setInput] = useState(q ?? '')
  const [refreshing, setRefreshing] = useState(false)
  const mailboxes = useMailboxes(accountId)
  const { selection, selectionMailboxId, clearSelection, setFolderDrawerOpen } = useUi()
  const listPanel = usePanelWidth('list')
  const listRef = useRef<HTMLElement | null>(null)
  const hasSelection = selectionMailboxId === mailboxId && selection.length > 0

  // A selection belongs to one folder *and* one filter; leaving either drops it
  // rather than silently carrying ids into a list where they aren't visible.
  useEffect(() => {
    clearSelection()
  }, [mailboxId, filter, clearSelection])

  // Depends only on the id, not the account object: only switching accounts
  // (or the query) should re-run the search.
  useEffect(() => {
    setInput(q ?? '')
    if (!q || !accountId) {
      setResults(null)
      return
    }
    let alive = true
    void searchEmails(accountId, q).then((r) => {
      if (alive) setResults(r ?? { headers: [], snippets: {} })
    })
    return () => {
      alive = false
    }
  }, [q, accountId])

  // Pull-to-refresh (touch): drag down while the list is scrolled to the top.
  const pull = useRef<{ y: number; scroller: HTMLElement | null } | null>(null)
  const onTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0]
    const scroller = (e.target as HTMLElement).closest('[data-testid="virtuoso-scroller"]')
    pull.current = touch ? { y: touch.clientY, scroller: scroller as HTMLElement | null } : null
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = pull.current
    pull.current = null
    if (!start || !account || refreshing) return
    const dy = (e.changedTouches[0]?.clientY ?? start.y) - start.y
    const atTop = !start.scroller || start.scroller.scrollTop === 0
    if (dy > 90 && atTop) {
      setRefreshing(true)
      void syncAccount(account.id)
        .catch(() => {})
        .finally(() => setRefreshing(false))
    }
  }

  // Both live in the URL, so each has to carry the other through: searching
  // must not silently drop the filter, nor filtering the search.
  const submitSearch = (value: string) =>
    void navigate({
      to: '/mail/$mailboxId',
      params: { mailboxId },
      search: { ...(value ? { q: value } : {}), ...(filter ? { filter } : {}) },
    })

  const toggleFilter = (next: MailFilter) =>
    void navigate({
      to: '/mail/$mailboxId',
      params: { mailboxId },
      search: { ...(q ? { q } : {}), ...(filter === next ? {} : { filter: next }) },
    })

  const inDetail = Boolean(params.emailId)
  const mailboxName = mailboxes?.find((m) => m.id === mailboxId)?.name ?? t('folder.list')
  // Search results are a complete answer from the server; the mailbox list is
  // a window that grows as you scroll. The mailbox list is filtered at the
  // index, so only search results need narrowing here.
  const list = useMemo(
    () =>
      results
        ? results.headers.filter((h) => matchesFilter(h, filter))
        : (mailbox.conversations ?? mailbox.emails),
    [results, filter, mailbox.conversations, mailbox.emails],
  )
  const loadMore = results ? undefined : mailbox.loadMore
  // Search answers with messages, so its results are never grouped — the hits
  // are what matched, not the threads they happen to sit in.
  const searchResults = results ? results.headers.filter((h) => matchesFilter(h, filter)) : null

  return (
    <div className="flex h-full gap-0 sm:gap-3">
      <section
        ref={listRef}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        // Only from lg up, where the list and the message are side by side.
        // Below that they take turns and w-full wins, so a width dragged on a
        // desktop cannot reach the phone layout.
        style={{ [PANEL_WIDTH_VAR]: `${listPanel.width}px` } as React.CSSProperties}
        className={`panel flex h-full w-full min-w-0 flex-col overflow-hidden max-sm:rounded-none max-sm:shadow-none lg:flex lg:w-[var(--mel-panel-w)] lg:shrink-0 ${inDetail ? 'hidden' : ''}`}
      >
        {hasSelection && account ? (
          <SelectionToolbar
            accountId={account.id}
            mailboxId={mailboxId}
            mailboxes={mailboxes ?? []}
            filter={filter}
          />
        ) : (
          <div className="flex items-center gap-2 px-2.5 pt-2.5 pb-1.5">
            {/*
             * Mobile entry point to the folder list, which is off-screen here.
             * It doubles as the only place that names the current folder on a
             * phone — the sidebar that would otherwise show it is hidden.
             */}
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label={`${mailboxName} — ${t('folder.switch')}`}
              onClick={() => setFolderDrawerOpen(true)}
              className="flex max-w-[45%] shrink-0 items-center gap-1.5 rounded-control bg-surface-2 py-2 pr-1.5 pl-2.5 text-[13px] text-ink-muted transition-colors hover:text-ink lg:hidden"
            >
              <Icon name="folder" size={14} className="shrink-0" />
              <span className="truncate">{mailboxName}</span>
              <Icon name="chevronDown" size={13} className="shrink-0" />
            </button>
            <div className="relative min-w-0 flex-1">
              <Icon
                name="search"
                size={14}
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-subtle"
              />
              <input
                id="mail-search"
                className="w-full rounded-control bg-surface-2 py-2 pr-7 pl-8 text-[13px] outline-none transition-shadow placeholder:text-ink-subtle focus:ring-2 focus:ring-accent"
                placeholder={t('mail.searchPlaceholder')}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitSearch(input.trim())
                  if (e.key === 'Escape') submitSearch('')
                }}
              />
              {q && (
                <Tooltip label={t('mail.searchClear')}>
                  <button
                    type="button"
                    aria-label={t('mail.searchClear')}
                    onClick={() => submitSearch('')}
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-subtle transition-colors hover:text-ink"
                  >
                    ✕
                  </button>
                </Tooltip>
              )}
            </div>
            <FilterToggle
              icon="mailUnread"
              label={t('mail.filter.unread')}
              active={filter === 'unread'}
              onClick={() => toggleFilter('unread')}
            />
            <FilterToggle
              icon="flag"
              label={t('mail.filter.flagged')}
              active={filter === 'flagged'}
              onClick={() => toggleFilter('flagged')}
            />
          </div>
        )}
        {refreshing && (
          <div className="animate-fade py-1 text-center text-[11px] text-ink-subtle">
            {t('mail.syncing')}
          </div>
        )}
        <div className="min-h-0 flex-1">
          {list === undefined || (q && results === null) ? (
            <ThreadListSkeleton />
          ) : list.length === 0 && q ? (
            <EmptyState icon="search" title={t('mail.searchNoResults')} />
          ) : list.length === 0 && filter ? (
            // Distinct from "No messages": the folder is not empty, the filter
            // is. Saying otherwise sends people looking for missing mail.
            <EmptyState
              icon={filter === 'unread' ? 'mailUnread' : 'flag'}
              title={filter === 'unread' ? t('mail.filter.noUnread') : t('mail.filter.noFlagged')}
              hint={
                filter === 'unread' ? t('mail.filter.noUnreadHint') : t('mail.filter.noFlaggedHint')
              }
            />
          ) : list.length === 0 && fullSync ? (
            // The folder is not empty, we simply have not fetched it yet —
            // saying "No messages" here was wrong, not merely unhelpful.
            <InitialSync progress={fullSync} />
          ) : (
            account && (
              <ThreadList
                accountId={account.id}
                {...(searchResults
                  ? { emails: searchResults }
                  : grouped
                    ? { conversations: mailbox.conversations ?? [] }
                    : { emails: mailbox.emails ?? [] })}
                snippets={results?.snippets}
                mailboxId={mailboxId}
                selectedId={params.emailId}
                onEndReached={loadMore}
              />
            )
          )}
        </div>
      </section>
      <ResizeHandle
        panel="list"
        label={t('mail.resizeList')}
        width={listPanel.width}
        targetRef={listRef}
        onCommit={listPanel.commit}
        onReset={listPanel.reset}
      />
      <div className={`h-full min-w-0 flex-1 lg:block ${inDetail ? '' : 'hidden'}`}>
        <div className="panel h-full overflow-hidden max-sm:rounded-none max-sm:shadow-none">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
