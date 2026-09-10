import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useUi } from '../../app/store'
import type { EmailBody, EmailHeader } from '../../domain/email'
import { formatFullDate } from '../../lib/dates'
import { hasRemoteContent, mailFrameDoc, textFrameDoc } from '../../lib/htmlSanitize'
import { imagePolicy } from '../../lib/imagePolicy'
import { useMailboxes } from './hooks'
import { t } from '../../lib/i18n'
import { getEmailBody } from '../../services/mail'
import {
  archiveEmail,
  deleteEmail,
  markNotSpam,
  markRead,
  setFlagged,
} from '../../services/mailActions'
import { buildReply } from '../../services/send'
import { connectionFor } from '../../sync/connections'
import { Avatar } from '../../ui/Avatar'
import { Icon, type IconName } from '../../ui/Icon'
import { Tooltip } from '../../ui/Tooltip'
import { Skeleton } from '../../ui/Skeleton'

function AddressLine({ label, list }: { label: string; list: EmailHeader['to'] }) {
  if (!list.length) return null
  return (
    <div className="truncate text-xs text-ink-muted">
      <span className="font-medium">{label}:</span>{' '}
      {list.map((a, i) => (
        <Tooltip key={i} label={a.email}>
          <span>
            {a.name || a.email}
            {i < list.length - 1 ? ', ' : ''}
          </span>
        </Tooltip>
      ))}
    </div>
  )
}

/**
 * `labelled` spells the action out next to its icon once the toolbar is wide
 * enough for it — a container query, not a viewport one: the pane's width comes
 * from the three-column layout around it, so a wide window can still leave it
 * narrow. Below that threshold, and for the toggles that stay bare (see the
 * call sites), the tooltip and `aria-label` carry the name exactly as before.
 */
function ActionButton({
  icon,
  label,
  onClick,
  active,
  labelled,
}: {
  icon: IconName
  label: string
  onClick: () => void
  active?: boolean
  labelled?: boolean
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`flex items-center gap-1.5 rounded-md p-2 transition-colors hover:bg-surface-2 ${active ? 'text-honey' : 'text-ink-muted hover:text-ink'}`}
      >
        <Icon name={icon} size={16} className="shrink-0" />
        {labelled && (
          <span className="hidden pr-0.5 text-[13px] leading-none font-medium @3xl:inline">
            {label}
          </span>
        )}
      </button>
    </Tooltip>
  )
}

/**
 * Resolved surface/ink colors for the message iframe. The iframe can't see the
 * parent's custom properties, so the values are read out and inlined — and
 * re-read when the theme attribute flips.
 */
function useFrameTheme() {
  const read = () => {
    const s = getComputedStyle(document.documentElement)
    return {
      fg: s.getPropertyValue('--mel-ink').trim() || '#000',
      bg: s.getPropertyValue('--mel-surface').trim() || '#fff',
    }
  }
  const [colors, setColors] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(read()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])
  return colors
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
  // Releasing remote content is per message, never sticky: the next message is
  // a different sender with a different reason to want your IP.
  const [released, setReleased] = useState(false)
  const mailboxes = useMailboxes(accountId)
  const junkId = mailboxes?.find((m) => m.role === 'junk')?.id
  const inJunk = Boolean(junkId && email.mailboxIds[junkId])
  // Junk keeps blocking even when the account is set to always load: a message
  // the server already thinks is spam is the last one to hand a confirmed
  // address to. Only an explicit per-message release opens it.
  const allowRemote = released || (imagePolicy() === 'always' && !inJunk)
  const navigate = useNavigate()
  const { openCompose, showSnackbar } = useUi()
  const frameTheme = useFrameTheme()

  // Fetching the body is keyed on the message identity alone: a keyword
  // change elsewhere (flag, read state) must not reset this to 'loading' and
  // re-fetch, or the reading pane flickers every time the row updates.
  useEffect(() => {
    let alive = true
    setBody('loading')
    setReleased(false)
    getEmailBody(accountId, email.id)
      .then((b) => alive && setBody(b))
      .catch(() => alive && setBody(null))
    return () => {
      alive = false
    }
  }, [accountId, email.id])

  // Separate from the body fetch above so that a keyword change alone (e.g.
  // another tab marking it read first) can be picked up without refetching.
  useEffect(() => {
    if (!email.keywords['$seen']) void markRead(accountId, email.id)
  }, [accountId, email.id, email.keywords])

  const backToList = () => void navigate({ to: '/mail/$mailboxId', params: { mailboxId } })

  async function onArchive() {
    const undo = await archiveEmail(accountId, email.id)
    backToList()
    // null means no Archive mailbox could be created. Staying silent here is
    // indistinguishable from success and leaves the message where it was.
    showSnackbar(
      undo
        ? { message: t('mail.archived'), actionLabel: t('mail.undo'), action: () => void undo() }
        : { message: t('mail.archiveFailed') },
    )
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
  const isHtmlMail = body !== 'loading' && body !== null && Boolean(body.html)
  const doc =
    body !== 'loading' && body
      ? body.html
        ? mailFrameDoc(body.html, allowRemote)
        : textFrameDoc(body.text ?? '', frameTheme)
      : null
  const sender = email.from[0]
  const blocked =
    !allowRemote && body !== 'loading' && body?.html ? hasRemoteContent(body.html) : false

  return (
    <article className="flex h-full min-w-0 flex-col bg-surface">
      <div className="@container flex items-center gap-1 px-2 py-1.5">
        <Tooltip label={t('mail.back')}>
          <Link
            to="/mail/$mailboxId"
            params={{ mailboxId }}
            className="rounded-md p-2 text-ink-muted transition-colors hover:bg-surface-2 lg:hidden"
            aria-label={t('mail.back')}
          >
            <Icon name="back" size={16} />
          </Link>
        </Tooltip>
        <span className="flex items-center rounded-control bg-surface-2/60 p-0.5">
          {inJunk && (
            <ActionButton
              icon="inbox"
              label={t('mail.notSpam')}
              labelled
              onClick={() => {
                void markNotSpam(accountId, email.id).then((undo) => {
                  backToList()
                  showSnackbar(
                    undo
                      ? {
                          message: t('mail.movedToInbox'),
                          actionLabel: t('mail.undo'),
                          action: () => void undo(),
                        }
                      : { message: t('mail.notSpamFailed') },
                  )
                })
              }}
            />
          )}
          <ActionButton
            icon="archive"
            label={t('mail.archive')}
            labelled
            onClick={() => void onArchive()}
          />
          <ActionButton
            icon="trash"
            label={t('mail.delete')}
            labelled
            onClick={() => void onDelete()}
          />
          {/*
           * Flag and mark-unread stay icon-only at every width: they are
           * toggles whose state the icon already carries (the flag fills), and
           * spelling both out is what tips the row into overflowing.
           */}
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
        </span>
        <span className="flex items-center rounded-control bg-surface-2/60 p-0.5">
          <ActionButton
            icon="reply"
            label={t('mail.reply')}
            labelled
            onClick={() => reply('reply')}
          />
          <ActionButton
            icon="replyAll"
            label={t('mail.replyAll')}
            labelled
            onClick={() => reply('replyAll')}
          />
          <ActionButton
            icon="forward"
            label={t('mail.forward')}
            labelled
            onClick={() => reply('forward')}
          />
        </span>
      </div>
      <header className="px-4 pt-1 pb-4 lg:px-6">
        <h2 className="mb-3 text-xl leading-snug font-semibold">
          {email.subject || t('mail.noSubject')}
        </h2>
        <div className="flex items-center gap-3">
          {sender && <Avatar name={sender.name ?? sender.email} email={sender.email} size={40} />}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <Tooltip label={sender?.email ?? t('mail.unknownSender')}>
                <span className="truncate text-sm font-semibold">
                  {sender?.name || sender?.email || t('mail.unknownSender')}
                </span>
              </Tooltip>
              <span className="shrink-0 text-xs text-ink-subtle">
                {formatFullDate(email.receivedAt)}
              </span>
            </div>
            <AddressLine label={t('mail.to')} list={email.to} />
            <AddressLine label={t('mail.cc')} list={email.cc} />
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 border-t border-line">
        {body === 'loading' && (
          <div className="animate-fade space-y-3 p-5">
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        )}
        {body === null && (
          <div className="flex h-full items-center justify-center text-sm text-danger">
            {t('mail.loadError')}
          </div>
        )}
        {blocked && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-xs text-ink-muted">
            <Icon name="offline" size={13} className="shrink-0" />
            <span className="min-w-0 flex-1">{t('mail.imagesBlocked')}</span>
            <button
              type="button"
              onClick={() => setReleased(true)}
              className="shrink-0 font-medium text-accent hover:underline"
            >
              {t('mail.loadImages')}
            </button>
          </div>
        )}
        {doc && (
          <iframe
            title={t('mail.messageFrame')}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={doc}
            className={`h-full w-full border-0 ${isHtmlMail ? 'bg-white' : 'bg-surface'}`}
          />
        )}
      </div>
      {body !== 'loading' && body && body.attachments.length > 0 && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
          {body.attachments.map((a, i) =>
            a.blobId ? (
              <span
                key={i}
                className="flex items-center overflow-hidden rounded-full bg-surface-2 text-xs transition-shadow hover:shadow-raised"
              >
                {/* No aria-label: the file name is the button's own text, and
                    a label would replace it with the generic verb. */}
                <Tooltip label={t('mail.openAttachment')}>
                  <button
                    type="button"
                    onClick={() =>
                      void openAttachment(accountId, a.blobId!, a.type, a.name ?? 'attachment')
                    }
                    className="flex items-center gap-1.5 py-1.5 pr-1.5 pl-3 transition-colors hover:text-accent"
                  >
                    <Icon name="paperclip" size={11} />
                    {a.name ?? 'attachment'}
                    <span className="text-ink-muted">
                      ({Math.max(1, Math.round(a.size / 1024))} KB)
                    </span>
                  </button>
                </Tooltip>
                <Tooltip label={t('mail.downloadAttachment')}>
                  <button
                    type="button"
                    aria-label={t('mail.downloadAttachment')}
                    onClick={() =>
                      void downloadAttachment(accountId, a.blobId!, a.type, a.name ?? 'attachment')
                    }
                    className="border-l border-line px-2 py-1 text-ink-muted hover:text-accent"
                  >
                    <Icon name="download" size={12} />
                  </button>
                </Tooltip>
              </span>
            ) : null,
          )}
        </footer>
      )}
    </article>
  )
}
