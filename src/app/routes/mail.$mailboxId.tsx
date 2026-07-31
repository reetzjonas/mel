import { Outlet, createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { ThreadList } from '../../features/mail/ThreadList'
import { useAccounts, useMailboxEmails } from '../../features/mail/hooks'
import { t } from '../../lib/i18n'
import { searchEmails, type SearchResult } from '../../services/search'
import { syncAccount } from '../../sync/engine'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { ThreadListSkeleton } from '../../ui/Skeleton'

export const Route = createFileRoute('/mail/$mailboxId')({
  component: MailboxView,
  validateSearch: (s: Record<string, unknown>): { q?: string } => ({
    q: typeof s['q'] === 'string' && s['q'] ? s['q'] : undefined,
  }),
})

function MailboxView() {
  const { mailboxId } = Route.useParams()
  const { q } = Route.useSearch()
  const params = useParams({ strict: false }) as { emailId?: string }
  const navigate = useNavigate()
  const accounts = useAccounts()
  const account = accounts?.[0]
  const emails = useMailboxEmails(account?.id, mailboxId)
  const [results, setResults] = useState<SearchResult | null>(null)
  const [input, setInput] = useState(q ?? '')
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    setInput(q ?? '')
    if (!q || !account) {
      setResults(null)
      return
    }
    let alive = true
    void searchEmails(account.id, q).then((r) => {
      if (alive) setResults(r ?? { headers: [], snippets: {} })
    })
    return () => {
      alive = false
    }
  }, [q, account?.id])

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

  const submitSearch = (value: string) =>
    void navigate({
      to: '/mail/$mailboxId',
      params: { mailboxId },
      search: value ? { q: value } : {},
    })

  const inDetail = Boolean(params.emailId)
  const list = results?.headers ?? emails

  return (
    <div className="flex h-full gap-0 sm:gap-3">
      <section
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        className={`panel flex h-full w-full min-w-0 flex-col overflow-hidden max-sm:rounded-none max-sm:shadow-none lg:flex lg:w-96 lg:shrink-0 ${inDetail ? 'hidden' : ''}`}
      >
        <div className="flex items-center gap-2 px-2.5 pt-2.5 pb-1.5">
          <div className="relative flex-1">
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
              <button
                type="button"
                title={t('mail.searchClear')}
                onClick={() => submitSearch('')}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-subtle transition-colors hover:text-ink"
              >
                ✕
              </button>
            )}
          </div>
        </div>
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
          ) : (
            account && (
              <ThreadList
                accountId={account.id}
                emails={list}
                snippets={results?.snippets}
                mailboxId={mailboxId}
                selectedId={params.emailId}
              />
            )
          )}
        </div>
      </section>
      <div className={`h-full min-w-0 flex-1 lg:block ${inDetail ? '' : 'hidden'}`}>
        <div className="panel h-full overflow-hidden max-sm:rounded-none max-sm:shadow-none">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
