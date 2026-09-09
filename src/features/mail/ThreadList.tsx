import { useNavigate } from '@tanstack/react-router'
import DOMPurify from 'dompurify'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useUi } from '../../app/store'
import type { EmailAddress, EmailHeader } from '../../domain/email'
import { formatListDate } from '../../lib/dates'
import { t } from '../../lib/i18n'
import { cleanPreview } from '../../lib/preview'
import { useMailboxes } from './hooks'
import {
  archiveEmail,
  deleteEmail,
  markNotSpam,
  markRead,
  setFlagged,
} from '../../services/mailActions'
import { Avatar } from '../../ui/Avatar'
import { EmptyState } from '../../ui/EmptyState'
import { Icon, type IconName } from '../../ui/Icon'

function senderLabel(from: EmailAddress[]): string {
  if (!from.length) return t('mail.unknownSender')
  return from.map((a) => a.name || a.email.split('@')[0]).join(', ')
}

const SWIPE_TRIGGER_PX = 90

/** Touch swipe: right = archive, left = delete. */
function useSwipe(onArchive: () => void, onDelete: () => void) {
  const [dx, setDx] = useState(0)
  const start = useRef<{ x: number; y: number } | null>(null)

  return {
    dx,
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        const touch = e.touches[0]
        if (touch) start.current = { x: touch.clientX, y: touch.clientY }
      },
      onTouchMove: (e: React.TouchEvent) => {
        const touch = e.touches[0]
        if (!start.current || !touch) return
        const deltaX = touch.clientX - start.current.x
        const deltaY = touch.clientY - start.current.y
        if (Math.abs(deltaX) > 12 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) setDx(deltaX)
      },
      onTouchEnd: () => {
        if (dx > SWIPE_TRIGGER_PX) onArchive()
        else if (dx < -SWIPE_TRIGGER_PX) onDelete()
        setDx(0)
        start.current = null
      },
    },
  }
}

function QuickAction({
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
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`rounded-md p-1.5 transition-colors hover:bg-surface-2 ${active ? 'text-honey' : 'text-ink-muted hover:text-ink'}`}
    >
      <Icon name={icon} size={14} />
    </button>
  )
}

function Row({
  accountId,
  email,
  snippet,
  selected,
  checked,
  inJunk,
  onToggleSelect,
  onOpen,
}: {
  accountId: string
  email: EmailHeader
  snippet?: { subject: string | null; preview: string | null }
  selected: boolean
  checked: boolean
  /** Shows the "not spam" shortcut; only messages filed as junk get it. */
  inJunk: boolean
  onToggleSelect: () => void
  onOpen: () => void
}) {
  const unread = !email.keywords['$seen']
  const flagged = Boolean(email.keywords['$flagged'])
  const sender = email.from[0]
  const { showSnackbar } = useUi()

  const doArchive = () =>
    void archiveEmail(accountId, email.id).then((undo) => {
      // null means no Archive mailbox could be created — saying nothing looks
      // exactly like success and leaves the message sitting where it was.
      showSnackbar(
        undo
          ? { message: t('mail.archived'), actionLabel: t('mail.undo'), action: () => void undo() }
          : { message: t('mail.archiveFailed') },
      )
    })
  const doDelete = () =>
    void deleteEmail(accountId, email.id).then((undo) => {
      showSnackbar(
        undo
          ? { message: t('mail.deleted'), actionLabel: t('mail.undo'), action: () => void undo() }
          : { message: t('mail.deleted') },
      )
    })

  const { dx, handlers } = useSwipe(doArchive, doDelete)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      data-selected={selected || undefined}
      data-checked={checked || undefined}
      {...handlers}
      style={dx ? { transform: `translateX(${dx}px)` } : undefined}
      className="group relative flex w-full cursor-pointer gap-3 rounded-control px-3 py-2.5 text-left transition-colors duration-100 hover:bg-surface-2 data-checked:bg-accent-wash data-selected:bg-accent-wash"
    >
      {/* The avatar doubles as the selection checkbox, but only reacts to the
          pointer being on the avatar itself — hovering anywhere in the row used
          to blank it out, which read as the sender icon disappearing. Desktop
          only, as with the quick actions; touch has no hover to reveal it. */}
      <span className="shrink-0 pt-0.5">
        {/* Exactly avatar-sized, so the overlay covers it edge to edge. The
            padding above must not sit on this box or inset-0 is offset by it. */}
        <span className="relative block h-9 w-9">
          <span className={checked ? 'invisible' : undefined}>
            <Avatar
              name={sender?.name ?? sender?.email ?? '?'}
              email={sender?.email ?? '?'}
              size={36}
            />
          </span>
          <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={t('bulk.select')}
            onClick={(e) => {
              e.stopPropagation()
              onToggleSelect()
            }}
            className={`absolute inset-0 items-center justify-center rounded-full transition-opacity ${
              checked
                ? 'flex bg-accent text-accent-ink'
                : 'hidden bg-surface-2 text-ink-muted opacity-0 ring-1 ring-line ring-inset hover:opacity-100 lg:flex'
            }`}
          >
            <Icon name="check" size={18} />
          </button>
          {unread && !checked && (
            <span className="absolute -top-0.5 -left-0.5 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-surface" />
          )}
        </span>
      </span>

      <span className="min-w-0 flex-1">
        {/* Quick actions: desktop hover only (mobile has swipe gestures) */}
        <span className="absolute top-1.5 right-2 z-10 hidden items-center rounded-control bg-raised p-0.5 shadow-raised ring-1 ring-line group-hover:lg:flex">
          <QuickAction
            icon={unread ? 'mail' : 'mailUnread'}
            label={unread ? t('mail.markRead') : t('mail.markUnread')}
            onClick={() => void markRead(accountId, email.id, unread)}
          />
          <QuickAction
            icon="flag"
            label={flagged ? t('mail.unflag') : t('mail.flag')}
            active={flagged}
            onClick={() => void setFlagged(accountId, email.id, !flagged)}
          />
          {inJunk && (
            <QuickAction
              icon="inbox"
              label={t('mail.notSpam')}
              onClick={() =>
                void markNotSpam(accountId, email.id).then((undo) =>
                  showSnackbar(
                    undo
                      ? {
                          message: t('mail.movedToInbox'),
                          actionLabel: t('mail.undo'),
                          action: () => void undo(),
                        }
                      : { message: t('mail.notSpamFailed') },
                  ),
                )
              }
            />
          )}
          <QuickAction icon="archive" label={t('mail.archive')} onClick={doArchive} />
          <QuickAction icon="trash" label={t('mail.delete')} onClick={doDelete} />
        </span>

        <span className="flex items-baseline justify-between gap-3">
          <span
            className={`min-w-0 truncate text-[13px] ${unread ? 'font-semibold text-ink' : 'font-medium text-ink'}`}
          >
            {senderLabel(email.from)}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-subtle group-hover:lg:invisible">
            {flagged && <Icon name="flag" size={11} className="text-honey" />}
            {email.hasAttachment && <Icon name="paperclip" size={11} />}
            {formatListDate(email.receivedAt)}
          </span>
        </span>
        <span
          data-testid="thread-subject"
          className={`block truncate text-[13px] ${unread ? 'font-medium text-ink' : 'text-ink-muted'}`}
        >
          {email.subject || t('mail.noSubject')}
        </span>
        {snippet?.preview ? (
          <span
            className="block truncate text-xs text-ink-subtle"
            dangerouslySetInnerHTML={{ __html: snippetHtml(cleanPreview(snippet.preview)) }}
          />
        ) : (
          <span className="block truncate text-xs text-ink-subtle">
            {cleanPreview(email.preview)}
          </span>
        )}
      </span>
    </div>
  )
}

export type Snippets = Record<string, { subject: string | null; preview: string | null }>

/**
 * SearchSnippet HTML may only contain <mark> highlights — everything else is
 * stripped. Done via DOMPurify (a real parser) rather than a tag-stripping
 * regex: a regex pass over untrusted input can be reopened by overlapping
 * matches (e.g. `<scr<script>ipt>` losing only the inner tag), which is
 * exactly what CodeQL's incomplete-multi-character-sanitization check flags.
 * `<mark>` itself is emitted with no attributes, so the highlight class is
 * safe to splice in afterwards — it's a fixed literal, not attacker input.
 */
function snippetHtml(s: string): string {
  const clean = DOMPurify.sanitize(s, { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: [] })
  return clean.replaceAll('<mark>', '<mark class="bg-accent-wash text-accent rounded-xs px-0.5">')
}

export function ThreadList({
  accountId,
  emails,
  snippets,
  mailboxId,
  selectedId,
  onEndReached,
}: {
  accountId: string
  emails: EmailHeader[]
  snippets?: Snippets
  mailboxId: string
  selectedId: string | undefined
  /** Materialise the next page; omitted when the list is already complete. */
  onEndReached?: (() => void) | undefined
}) {
  const navigate = useNavigate()
  const { selection, selectionMailboxId, toggleSelected } = useUi()
  const mailboxes = useMailboxes(accountId)
  const junkId = mailboxes?.find((m) => m.role === 'junk')?.id
  // A Set, not the array: "select the whole folder" can hold thousands of ids,
  // and Array.includes per row turns every scroll frame into rows × ids work.
  const selected = useMemo(
    () => new Set(selectionMailboxId === mailboxId ? selection : []),
    [selection, selectionMailboxId, mailboxId],
  )
  const open = (id: string) =>
    void navigate({ to: '/mail/$mailboxId/$emailId', params: { mailboxId, emailId: id } })

  // j/k keyboard navigation (desktop)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return
      if (e.key !== 'j' && e.key !== 'k') return
      const idx = selectedId ? emails.findIndex((m) => m.id === selectedId) : -1
      const next = e.key === 'j' ? Math.min(idx + 1, emails.length - 1) : Math.max(idx - 1, 0)
      // Stepping onto the last loaded row pulls in the next page, so keyboard
      // navigation doesn't stop at the window edge.
      if (e.key === 'j' && next >= emails.length - 1) onEndReached?.()
      const target = emails[next]
      if (target && target.id !== selectedId) open(target.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!emails.length) {
    return <EmptyState icon="inbox" title={t('mail.noMessages')} hint={t('mail.noMessagesHint')} />
  }

  return (
    <Virtuoso
      className="px-1.5 py-1.5"
      data={emails}
      endReached={onEndReached}
      increaseViewportBy={600}
      computeItemKey={(_, e) => e.id}
      itemContent={(_, email) => (
        <Row
          accountId={accountId}
          email={email}
          snippet={snippets?.[email.id]}
          selected={email.id === selectedId}
          checked={selected.has(email.id)}
          inJunk={Boolean(junkId && email.mailboxIds[junkId])}
          onToggleSelect={() => toggleSelected(mailboxId, email.id)}
          onOpen={() => open(email.id)}
        />
      )}
    />
  )
}
