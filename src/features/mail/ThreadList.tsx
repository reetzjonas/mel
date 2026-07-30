import { useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { EmailAddress, EmailHeader } from '../../domain/email'
import { formatListDate } from '../../lib/dates'
import { t } from '../../lib/i18n'
import { Icon } from '../../ui/Icon'

function senderLabel(from: EmailAddress[]): string {
  if (!from.length) return t('mail.unknownSender')
  return from.map((a) => a.name || a.email.split('@')[0]).join(', ')
}

function Row({
  email,
  selected,
  onOpen,
}: {
  email: EmailHeader
  selected: boolean
  onOpen: () => void
}) {
  const unread = !email.keywords['$seen']
  return (
    <button
      type="button"
      onClick={onOpen}
      data-selected={selected || undefined}
      className="relative block w-full border-b border-line px-4 py-2.5 text-left transition-colors hover:bg-surface-2 data-selected:bg-accent/10"
    >
      {unread && (
        <span className="absolute top-1/2 left-1.5 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-accent" />
      )}
      <div className="flex items-baseline justify-between gap-3">
        <span className={`min-w-0 truncate text-sm ${unread ? 'font-semibold' : 'text-ink'}`}>
          {senderLabel(email.from)}
        </span>
        <span className="shrink-0 text-[11px] text-ink-muted tabular-nums">
          {formatListDate(email.receivedAt)}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={`min-w-0 flex-1 truncate text-[13px] ${unread ? 'font-medium' : 'text-ink-muted'}`}
        >
          {email.subject || t('mail.noSubject')}
        </span>
        {email.hasAttachment && (
          <Icon name="paperclip" size={12} className="shrink-0 text-ink-muted" />
        )}
      </div>
      <div className="truncate text-xs text-ink-muted/80">{email.preview}</div>
    </button>
  )
}

export function ThreadList({
  emails,
  mailboxId,
  selectedId,
}: {
  emails: EmailHeader[]
  mailboxId: string
  selectedId: string | undefined
}) {
  const navigate = useNavigate()
  const open = (id: string) =>
    void navigate({ to: '/mail/$mailboxId/$emailId', params: { mailboxId, emailId: id } })

  // j/k keyboard navigation (desktop)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return
      if (e.key !== 'j' && e.key !== 'k') return
      const idx = selectedId ? emails.findIndex((m) => m.id === selectedId) : -1
      const next = e.key === 'j' ? Math.min(idx + 1, emails.length - 1) : Math.max(idx - 1, 0)
      const target = emails[next]
      if (target && target.id !== selectedId) open(target.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!emails.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-muted">
        <Icon name="inbox" size={28} className="opacity-40" />
        <span className="text-sm">{t('mail.noMessages')}</span>
      </div>
    )
  }

  return (
    <Virtuoso
      data={emails}
      computeItemKey={(_, e) => e.id}
      itemContent={(_, email) => (
        <Row email={email} selected={email.id === selectedId} onOpen={() => open(email.id)} />
      )}
    />
  )
}
