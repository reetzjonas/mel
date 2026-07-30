import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useUi } from '../../app/store'
import type { EmailBody, EmailHeader } from '../../domain/email'
import { formatFullDate } from '../../lib/dates'
import { mailFrameDoc, textFrameDoc } from '../../lib/htmlSanitize'
import { t } from '../../lib/i18n'
import { getEmailBody } from '../../services/mail'
import { archiveEmail, deleteEmail, markRead, setFlagged } from '../../services/mailActions'
import { buildReply } from '../../services/send'
import { connectionFor } from '../../sync/connections'
import { Avatar } from '../../ui/Avatar'
import { Icon, type IconName } from '../../ui/Icon'

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

function ActionButton({
  icon,
  label,
  onClick,
  active,
}: {
  icon: IconName
  label: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={`rounded-md p-2 hover:bg-surface-2 ${active ? 'text-accent' : 'text-ink-muted hover:text-ink'}`}
    >
      <Icon name={icon} size={16} />
    </button>
  )
}

/** Types the browser can render directly — opened in a new tab instead of saved. */
const PREVIEWABLE = /^(image\/|application\/pdf|text\/|audio\/|video\/)/

async function fetchAttachment(accountId: string, blobId: string, type: string, name: string) {
  const conn = await connectionFor(accountId)
  if (!conn.mail) return null
  const blob = await conn.mail.downloadBlob(blobId, type, name)
  // Re-wrap with the declared type so the browser previews instead of saving.
  return URL.createObjectURL(new Blob([blob], { type }))
}

async function openAttachment(accountId: string, blobId: string, type: string, name: string) {
  const url = await fetchAttachment(accountId, blobId, type, name)
  if (!url) return
  if (PREVIEWABLE.test(type)) {
    window.open(url, '_blank', 'noopener')
  } else {
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

async function downloadAttachment(accountId: string, blobId: string, type: string, name: string) {
  const url = await fetchAttachment(accountId, blobId, type, name)
  if (!url) return
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function ReadingPane({
  accountId,
  email,
  mailboxId,
  ownEmail,
}: {
  accountId: string
  email: EmailHeader
  mailboxId: string
  ownEmail: string
}) {
  const [body, setBody] = useState<EmailBody | null | 'loading'>('loading')
  const navigate = useNavigate()
  const { openCompose, showSnackbar } = useUi()

  useEffect(() => {
    let alive = true
    setBody('loading')
    getEmailBody(accountId, email.id)
      .then((b) => alive && setBody(b))
      .catch(() => alive && setBody(null))
    // Opening a message marks it read.
    if (!email.keywords['$seen']) void markRead(accountId, email.id)
    return () => {
      alive = false
    }
  }, [accountId, email.id])

  const backToList = () =>
    void navigate({ to: '/mail/$mailboxId', params: { mailboxId } })

  async function onArchive() {
    const undo = await archiveEmail(accountId, email.id)
    backToList()
    if (undo) showSnackbar({ message: t('mail.archived'), actionLabel: t('mail.undo'), action: () => void undo() })
  }

  async function onDelete() {
    const undo = await deleteEmail(accountId, email.id)
    backToList()
    showSnackbar(
      undo
        ? { message: t('mail.deleted'), actionLabel: t('mail.undo'), action: () => void undo() }
        : { message: t('mail.deleted') },
    )
  }

  const reply = (mode: 'reply' | 'replyAll' | 'forward') => {
    const b = body === 'loading' ? null : body
    openCompose(buildReply(email, b, mode, ownEmail))
  }

  const flagged = Boolean(email.keywords['$flagged'])
  const doc =
    body !== 'loading' && body
      ? body.html
        ? mailFrameDoc(body.html)
        : textFrameDoc(body.text ?? '')
      : null
  const sender = email.from[0]

  return (
    <article className="flex h-full min-w-0 flex-col bg-surface">
      <div className="flex items-center gap-0.5 border-b border-line px-2 py-1">
        <Link
          to="/mail/$mailboxId"
          params={{ mailboxId }}
          className="rounded-md p-2 text-ink-muted hover:bg-surface-2 lg:hidden"
          title={t('mail.back')}
        >
          <Icon name="back" size={16} />
        </Link>
        <ActionButton icon="archive" label={t('mail.archive')} onClick={() => void onArchive()} />
        <ActionButton icon="trash" label={t('mail.delete')} onClick={() => void onDelete()} />
        <ActionButton
          icon="flag"
          label={flagged ? t('mail.unflag') : t('mail.flag')}
          active={flagged}
          onClick={() => void setFlagged(accountId, email.id, !flagged)}
        />
        <ActionButton
          icon="mailUnread"
          label={t('mail.markUnread')}
          onClick={() => {
            void markRead(accountId, email.id, false)
            backToList()
          }}
        />
        <span className="mx-1 h-5 w-px bg-line" />
        <ActionButton icon="reply" label={t('mail.reply')} onClick={() => reply('reply')} />
        <ActionButton icon="replyAll" label={t('mail.replyAll')} onClick={() => reply('replyAll')} />
        <ActionButton icon="forward" label={t('mail.forward')} onClick={() => reply('forward')} />
      </div>
      <header className="border-b border-line px-4 py-3 lg:px-6">
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
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2">
          {body.attachments.map((a, i) =>
            a.blobId ? (
              <span
                key={i}
                className="flex items-center overflow-hidden rounded-full bg-surface-2 text-xs"
              >
                <button
                  type="button"
                  title={t('mail.openAttachment')}
                  onClick={() =>
                    void openAttachment(accountId, a.blobId!, a.type, a.name ?? 'attachment')
                  }
                  className="flex items-center gap-1.5 py-1 pr-1.5 pl-3 hover:text-accent"
                >
                  <Icon name="paperclip" size={11} />
                  {a.name ?? 'attachment'}
                  <span className="text-ink-muted">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
                </button>
                <button
                  type="button"
                  title={t('mail.downloadAttachment')}
                  onClick={() =>
                    void downloadAttachment(accountId, a.blobId!, a.type, a.name ?? 'attachment')
                  }
                  className="border-l border-line px-2 py-1 text-ink-muted hover:text-accent"
                >
                  <Icon name="download" size={12} />
                </button>
              </span>
            ) : null,
          )}
        </footer>
      )}
    </article>
  )
}
