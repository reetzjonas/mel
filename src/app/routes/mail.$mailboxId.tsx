import { Outlet, createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ThreadList } from '../../features/mail/ThreadList'
import { useAccounts, useMailboxEmails } from '../../features/mail/hooks'
import type { EmailHeader } from '../../domain/email'
import { t } from '../../lib/i18n'
import { searchEmails } from '../../services/search'
import { Icon } from '../../ui/Icon'

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
  const [results, setResults] = useState<EmailHeader[] | null>(null)
  const [input, setInput] = useState(q ?? '')

  useEffect(() => {
    setInput(q ?? '')
    if (!q || !account) {
      setResults(null)
      return
    }
    let alive = true
    void searchEmails(account.id, q).then((r) => {
      if (alive) setResults(r?.headers ?? [])
    })
    return () => {
      alive = false
    }
  }, [q, account?.id])

  const submitSearch = (value: string) =>
    void navigate({
      to: '/mail/$mailboxId',
      params: { mailboxId },
      search: value ? { q: value } : {},
    })

  const inDetail = Boolean(params.emailId)
  const list = results ?? emails

  return (
    <div className="flex h-full">
      <section
        className={`flex h-full w-full min-w-0 flex-col border-r border-line lg:flex lg:w-96 lg:shrink-0 ${inDetail ? 'hidden' : ''}`}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <div className="relative flex-1">
            <Icon
              name="search"
              size={14}
              className="absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-muted"
            />
            <input
              id="mail-search"
              className="w-full rounded-lg bg-surface-2 py-1.5 pr-7 pl-8 text-sm outline-none placeholder:text-ink-muted/70 focus:ring-1 focus:ring-accent"
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
                className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-muted hover:text-ink"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1">
          {list === undefined || (q && results === null) ? (
            <div className="flex h-full items-center justify-center text-sm text-ink-muted">
              {t('mail.syncing')}
            </div>
          ) : list.length === 0 && q ? (
            <div className="flex h-full items-center justify-center text-sm text-ink-muted">
              {t('mail.searchNoResults')}
            </div>
          ) : (
            account && (
              <ThreadList
                accountId={account.id}
                emails={list}
                mailboxId={mailboxId}
                selectedId={params.emailId}
              />
            )
          )}
        </div>
      </section>
      <div className={`h-full min-w-0 flex-1 lg:block ${inDetail ? '' : 'hidden'}`}>
        <Outlet />
      </div>
    </div>
  )
}
