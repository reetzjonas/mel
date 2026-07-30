import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { EmailBody, EmailHeader } from '../../domain/email'
import { formatFullDate } from '../../lib/dates'
import { mailFrameDoc, textFrameDoc } from '../../lib/htmlSanitize'
import { t } from '../../lib/i18n'
import { getEmailBody } from '../../services/mail'
import { Avatar } from '../../ui/Avatar'
import { Icon } from '../../ui/Icon'

function AddressLine({ label, list }: { label: string; list: EmailHeader['to'] }) {
  if (!list.length) return null
  return (
    <div className="truncate text-xs text-ink-muted">
      <span className="font-medium">{label}:</span>{' '}
      {list.map((a, i) => (
        <span key={i} title={a.email}>
          {a.name || a.email}
          {i < list.length - 1 ? ', ' : ''}
        </span>
      ))}
    </div>
  )
}

export function ReadingPane({
  accountId,
  email,
  mailboxId,
}: {
  accountId: string
  email: EmailHeader
  mailboxId: string
}) {
  const [body, setBody] = useState<EmailBody | null | 'loading'>('loading')

  useEffect(() => {
    let alive = true
    setBody('loading')
    getEmailBody(accountId, email.id)
      .then((b) => alive && setBody(b))
      .catch(() => alive && setBody(null))
    return () => {
      alive = false
    }
  }, [accountId, email.id])

  const doc =
    body !== 'loading' && body
      ? body.html
        ? mailFrameDoc(body.html)
        : textFrameDoc(body.text ?? '')
      : null

  const sender = email.from[0]

  return (
    <article className="flex h-full min-w-0 flex-col bg-surface">
      <header className="border-b border-line px-4 py-3 lg:px-6">
        <div className="mb-2 lg:hidden">
          <Link
            to="/mail/$mailboxId"
            params={{ mailboxId }}
            className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-ink-muted hover:bg-surface-2"
          >
            <Icon name="back" size={15} />
            {t('mail.back')}
          </Link>
        </div>
        <h2 className="mb-2.5 text-[17px] leading-snug font-semibold">
          {email.subject || t('mail.noSubject')}
        </h2>
        <div className="flex items-center gap-3">
          {sender && <Avatar name={sender.name ?? sender.email} email={sender.email} />}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-sm font-medium" title={sender?.email}>
                {sender?.name || sender?.email || t('mail.unknownSender')}
              </span>
              <span className="shrink-0 text-xs text-ink-muted">
                {formatFullDate(email.receivedAt)}
              </span>
            </div>
            <AddressLine label={t('mail.to')} list={email.to} />
            <AddressLine label={t('mail.cc')} list={email.cc} />
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {body === 'loading' && (
          <div className="flex h-full items-center justify-center text-sm text-ink-muted">
            {t('mail.loading')}
          </div>
        )}
        {body === null && (
          <div className="flex h-full items-center justify-center text-sm text-danger">
            {t('mail.loadError')}
          </div>
        )}
        {doc && (
          <iframe
            title={t('mail.messageFrame')}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={doc}
            className="h-full w-full border-0 bg-white"
          />
        )}
      </div>
      {body !== 'loading' && body && body.attachments.length > 0 && (
        <footer className="flex items-center gap-2 border-t border-line px-4 py-2 text-xs text-ink-muted">
          <Icon name="paperclip" size={13} />
          {body.attachments.length}{' '}
          {body.attachments.length === 1 ? t('mail.attachment') : t('mail.attachments')} (
          {t('mail.attachmentsSoon')})
        </footer>
      )}
    </article>
  )
}
