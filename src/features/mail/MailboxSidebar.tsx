import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useUi } from '../../app/store'
import type { Mailbox } from '../../domain/mailbox'
import { t } from '../../lib/i18n'
import { syncAccount } from '../../sync/engine'
import { Icon, type IconName } from '../../ui/Icon'

const ROLE_ICONS: Record<string, IconName> = {
  inbox: 'inbox',
  drafts: 'draft',
  sent: 'send',
  archive: 'archive',
  junk: 'junk',
  trash: 'trash',
}

export function MailboxSidebar({
  accountId,
  accountLabel,
  mailboxes,
}: {
  accountId: string
  accountLabel: string
  mailboxes: Mailbox[]
}) {
  const [refreshing, setRefreshing] = useState(false)
  const refresh = () => {
    setRefreshing(true)
    void syncAccount(accountId)
      .catch(() => {})
      .finally(() => setRefreshing(false))
  }

  const { openCompose } = useUi()

  return (
    <nav className="flex h-full flex-col overflow-y-auto px-2 py-3">
      <button
        type="button"
        onClick={() => openCompose({})}
        className="mb-3 hidden items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 lg:flex"
      >
        <Icon name="compose" size={15} />
        {t('compose.new')}
      </button>
      <div className="mb-2 flex items-center justify-between px-2">
        <span
          className="truncate text-xs font-semibold tracking-wide text-ink-muted uppercase"
          title={accountLabel}
        >
          {accountLabel}
        </span>
        <button
          type="button"
          title={t('mail.refresh')}
          onClick={refresh}
          className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="refresh" size={14} className={refreshing ? 'animate-spin' : undefined} />
        </button>
      </div>
      <div className="space-y-0.5">
        {mailboxes.map((m) => (
          <Link
            key={m.id}
            to="/mail/$mailboxId"
            params={{ mailboxId: m.id }}
            className="group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink [&.active]:bg-accent/10 [&.active]:font-medium [&.active]:text-accent"
            style={{ paddingLeft: m.parentId ? '2rem' : undefined }}
          >
            <Icon name={ROLE_ICONS[m.role ?? ''] ?? 'folder'} size={15} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{m.name}</span>
            {m.unreadEmails > 0 && (
              <span className="text-xs font-semibold tabular-nums">{m.unreadEmails}</span>
            )}
          </Link>
        ))}
      </div>
    </nav>
  )
}
