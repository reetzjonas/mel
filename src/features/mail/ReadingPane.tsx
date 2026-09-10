import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useUi } from '../../app/store'
import type { EmailBody, EmailHeader } from '../../domain/email'
import { formatFullDate, formatListDate } from '../../lib/dates'
import { cleanPreview } from '../../lib/preview'
import { hasRemoteContent, mailFrameDoc, textFrameDoc } from '../../lib/htmlSanitize'
import { imagePolicy } from '../../lib/imagePolicy'
import { useMailboxes, useThread } from './hooks'
import { foldThread, type ThreadSlot } from './conversations'
import { t } from '../../lib/i18n'
import { getEmailBody } from '../../services/mail'
import {
  bulkArchive,
  bulkDelete,
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

/** A small caption on a message row: draft, or just arrived. */
function Tag({ label, tone }: { label: string; tone: 'accent' | 'honey' }) {
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${
        tone === 'accent' ? 'bg-accent text-accent-ink' : 'bg-honey/15 text-honey'
      }`}
    >
      {label}
    </span>
  )
}

/** One message of a conversation, folded away: enough to recognise it by. */
function CollapsedMessage({
  message,
  arrived,
  onOpen,
}: {
  message: EmailHeader
  /** Turned up while this conversation was open, rather than being part of it
   *  when you got here — worth pointing at, since nothing else moved. */
  arrived: boolean
  onOpen: () => void
}) {
  const sender = message.from[0]
  const unread = !message.keywords['$seen']
  const draft = Boolean(message.keywords['$draft'])
  const ref = useRef<HTMLButtonElement>(null)

  // A message arriving under a pane you are reading is easy to miss entirely:
  // bring it into view once, without yanking the message you are reading away.
  useEffect(() => {
    if (arrived) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [arrived])

  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      aria-label={`${t('mail.showMessage')}: ${sender?.name || sender?.email || t('mail.unknownSender')}`}
      className={`flex w-full shrink-0 items-center gap-3 border-b px-4 py-2 text-left transition-colors lg:px-6 ${
        arrived
          ? 'animate-rise border-accent bg-accent-wash hover:bg-accent-wash'
          : 'border-line hover:bg-surface-2'
      }`}
    >
      <Avatar name={sender?.name ?? sender?.email ?? '?'} email={sender?.email ?? '?'} size={24} />
      <span
        className={`shrink-0 truncate text-[13px] ${unread ? 'font-semibold text-ink' : 'text-ink'}`}
      >
        {sender?.name || sender?.email || t('mail.unknownSender')}
      </span>
      {draft && <Tag label={t('mail.draft')} tone="honey" />}
      {arrived && <Tag label={t('mail.arrived')} tone="accent" />}
      <span className="min-w-0 flex-1 truncate text-xs text-ink-subtle">
        {cleanPreview(message.preview)}
      </span>
      <span className="shrink-0 text-[11px] text-ink-subtle">
        {formatListDate(message.receivedAt)}
      </span>
    </button>
  )
}

/** The messages between the ends of a long thread, folded into one band. */
function FoldedBand({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`${t('mail.expandFolded')}: ${count} ${t('mail.messagesCount')}`}
      className="flex w-full shrink-0 items-center gap-3 border-b border-line px-4 py-2 transition-colors hover:bg-surface-2 lg:px-6"
    >
      <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-surface-2 px-2 text-[11px] font-semibold text-ink-muted">
        {count}
      </span>
      <span className="h-px flex-1 bg-line-strong" />
    </button>
  )
}

export function ReadingPane({
  accountId,
  email: focused,
  mailboxId,
  ownEmail,
}: {
  accountId: string
  /** The message the URL names — the one that starts out expanded. */
  email: EmailHeader
  mailboxId: string
  ownEmail: string
}) {
  const grouped = useUi((s) => s.conversationView)
  // Only asked for while grouping is on, so the ungrouped pane costs no extra
  // query at all.
  const thread = useThread(accountId, grouped ? focused.threadId : undefined, mailboxId)
  /*
   * The whole conversation, oldest first — falling back to the routed message
   * alone while the thread query is still in flight, so the pane never blanks
   * out between messages.
   */
  const messages = grouped && thread?.length ? thread : [focused]
  /*
   * Exactly one message is open at a time.
   *
   * Not a design preference: a message body renders in a sandboxed iframe
   * *without* allow-same-origin (mail scripts must not reach our origin), and
   * that means its content height cannot be measured from here. Stacked bodies
   * would each need a guessed height. One expanded message can simply take the
   * space that is left.
   */
  const [expandedId, setExpandedId] = useState(focused.id)
  const [showAll, setShowAll] = useState(false)
  /**
   * Which messages were already here when this conversation was opened.
   * Seeded once the thread has actually loaded — seeding from the routed
   * message alone would make the rest of the thread look like it just arrived.
   */
  const known = useRef<Set<string> | null>(null)
  // Adjusted during render rather than in an effect: opening another message
  // from the list must not paint the previous one's body first.
  const [routed, setRouted] = useState(focused.id)
  if (routed !== focused.id) {
    setRouted(focused.id)
    setExpandedId(focused.id)
    setShowAll(false)
    known.current = null
  }
  if (known.current === null && (!grouped || thread !== undefined)) {
    known.current = new Set(messages.map((m) => m.id))
  }
  const arrived = (id: string) => known.current !== null && !known.current.has(id)
  const expanded = messages.find((m) => m.id === expandedId) ?? focused
  /** What a conversation-wide action applies to: this folder's messages. */
  const threadIds = messages.filter((m) => m.mailboxIds[mailboxId]).map((m) => m.id)
  const isThread = messages.length > 1

  /*
   * A long thread is folded in the middle (see foldThread); the open message
   * is always a slot of its own, so the list splits there into what goes above
   * the body and what goes below.
   */
  const expandedIndex = messages.indexOf(expanded)
  const slots = foldThread({
    count: messages.length,
    expandedIndex,
    arrived: new Set(messages.flatMap((m, i) => (arrived(m.id) ? [i] : []))),
    showAll,
  })
  const splitAt = slots.findIndex((slot) => 'index' in slot && slot.index === expandedIndex)

  const renderSlots = (entries: ThreadSlot[]) =>
    entries.map((entry) =>
      'folded' in entry ? (
        <FoldedBand
          key={`fold-${entry.folded[0]}`}
          count={entry.folded.length}
          onExpand={() => setShowAll(true)}
        />
      ) : (
        <CollapsedMessage
          key={messages[entry.index]!.id}
          message={messages[entry.index]!}
          arrived={arrived(messages[entry.index]!.id)}
          onOpen={() => setExpandedId(messages[entry.index]!.id)}
        />
      ),
    )
  const [body, setBody] = useState<EmailBody | null | 'loading'>('loading')
  // Releasing remote content is per message, never sticky: the next message is
  // a different sender with a different reason to want your IP.
  const [released, setReleased] = useState(false)
  const mailboxes = useMailboxes(accountId)
  const junkId = mailboxes?.find((m) => m.role === 'junk')?.id
  const inJunk = Boolean(junkId && expanded.mailboxIds[junkId])
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
    getEmailBody(accountId, expanded.id)
      .then((b) => alive && setBody(b))
      .catch(() => alive && setBody(null))
    return () => {
      alive = false
    }
  }, [accountId, expanded.id])

  // Separate from the body fetch above so that a keyword change alone (e.g.
  // another tab marking it read first) can be picked up without refetching.
  useEffect(() => {
    if (!expanded.keywords['$seen']) void markRead(accountId, expanded.id)
  }, [accountId, expanded.id, expanded.keywords])

  const backToList = () => void navigate({ to: '/mail/$mailboxId', params: { mailboxId } })

  // Archive and delete take the conversation with them when the pane is
  // showing one — leaving the other half of an exchange behind in the folder
  // is not what "archive" means to anyone reading it. Everything else (flag,
  // unread, reply, not spam) stays on the message you have open, which is the
  // only one those can sensibly mean.
  async function onArchive() {
    const undo = await bulkArchive(accountId, isThread ? threadIds : [expanded.id])
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
    const undo = await bulkDelete(accountId, isThread ? threadIds : [expanded.id])
    backToList()
    showSnackbar(
      undo
        ? { message: t('mail.deleted'), actionLabel: t('mail.undo'), action: () => void undo() }
        : { message: t('mail.deleted') },
    )
  }

  const reply = (mode: 'reply' | 'replyAll' | 'forward') => {
    const b = body === 'loading' ? null : body
    openCompose(buildReply(expanded, b, mode, ownEmail))
  }

  const flagged = Boolean(expanded.keywords['$flagged'])
  const isHtmlMail = body !== 'loading' && body !== null && Boolean(body.html)
  const doc =
    body !== 'loading' && body
      ? body.html
        ? mailFrameDoc(body.html, allowRemote)
        : textFrameDoc(body.text ?? '', frameTheme)
      : null
  const sender = expanded.from[0]
  // Senders, oldest first, each named once: the same shape the list row uses.
  const participants = [
    ...new Map(
      messages.flatMap((m) => m.from.map((a) => [a.email.toLowerCase(), a.name || a.email])),
    ).values(),
  ].join(', ')
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
                void markNotSpam(accountId, expanded.id).then((undo) => {
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
            label={isThread ? t('mail.archiveThread') : t('mail.archive')}
            labelled
            onClick={() => void onArchive()}
          />
          <ActionButton
            icon="trash"
            label={isThread ? t('mail.deleteThread') : t('mail.delete')}
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
            onClick={() => void setFlagged(accountId, expanded.id, !flagged)}
          />
          <ActionButton
            icon="mailUnread"
            label={t('mail.markUnread')}
            onClick={() => {
              void markRead(accountId, expanded.id, false)
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
      <header className="px-4 pt-1 pb-3 lg:px-6">
        <h2 className="text-xl leading-snug font-semibold">
          {expanded.subject || t('mail.noSubject')}
        </h2>
        {isThread && (
          <p className="truncate text-xs text-ink-subtle">
            {`${messages.length} ${t('mail.messagesCount')} · ${participants}`}
          </p>
        )}
      </header>
      {/*
       * The conversation in order, with the open message taking whatever space
       * the folded ones leave. Ordered oldest first, so the reply you are
       * reading sits below what it answers.
       */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-line">
        {renderSlots(slots.slice(0, splitAt))}
        <div className="flex shrink-0 items-center gap-3 px-4 py-3 lg:px-6">
          {sender && <Avatar name={sender.name ?? sender.email} email={sender.email} size={40} />}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <Tooltip label={sender?.email ?? t('mail.unknownSender')}>
                <span className="truncate text-sm font-semibold">
                  {sender?.name || sender?.email || t('mail.unknownSender')}
                </span>
              </Tooltip>
              {/* Opened from the Drafts folder: it is yours and unsent, and
                  nothing else about the pane says so. */}
              {expanded.keywords['$draft'] && <Tag label={t('mail.draft')} tone="honey" />}
              <span className="shrink-0 text-xs text-ink-subtle">
                {formatFullDate(expanded.receivedAt)}
              </span>
            </div>
            <AddressLine label={t('mail.to')} list={expanded.to} />
            <AddressLine label={t('mail.cc')} list={expanded.cc} />
          </div>
        </div>
        {/* A floor under the open message: a long conversation is a stack of
            folded rows, and without one they would squeeze the body it belongs
            to down to nothing instead of letting the column scroll. */}
        <div className="min-h-96 flex-1 border-t border-line">
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
                        void downloadAttachment(
                          accountId,
                          a.blobId!,
                          a.type,
                          a.name ?? 'attachment',
                        )
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
        {renderSlots(slots.slice(splitAt + 1))}
      </div>
    </article>
  )
}
