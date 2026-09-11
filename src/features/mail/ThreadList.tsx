import { useNavigate } from '@tanstack/react-router'
import DOMPurify from 'dompurify'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useUi } from '../../app/store'
import type { EmailAddress, EmailHeader } from '../../domain/email'
import type { Conversation } from './conversations'
import { dateBucket, formatListDate, type DateBucket } from '../../lib/dates'
import { t, type MsgKey } from '../../lib/i18n'
import { cleanPreview } from '../../lib/preview'
import { useMailboxes } from './hooks'
import { bulkArchive, bulkDelete, bulkNotSpam, bulkSetKeyword } from '../../services/mailActions'
import { Avatar } from '../../ui/Avatar'
import { setMailDrag } from './dragAndDrop'
import { EmptyState } from '../../ui/EmptyState'
import { Icon, type IconName } from '../../ui/Icon'
import { Tooltip } from '../../ui/Tooltip'

function senderLabel(from: EmailAddress[]): string {
  if (!from.length) return t('mail.unknownSender')
  return from.map((a) => a.name || a.email.split('@')[0]).join(', ')
}

/**
 * What a row stands for. A single message and a whole conversation differ only
 * in how many messages they carry, so both render through one component rather
 * than two that drift apart — `ids` is what the row's actions apply to, which
 * for a conversation is its messages *in the listed mailbox* and never the
 * copies elsewhere.
 */
interface RowItem {
  /** The message shown: the only one, or the newest of the conversation. */
  email: EmailHeader
  ids: string[]
  /** Messages in the conversation across folders; 1 for a lone message. */
  count: number
  people: EmailAddress[]
  unread: boolean
  flagged: boolean
  hasAttachment: boolean
}

function messageItem(email: EmailHeader): RowItem {
  return {
    email,
    ids: [email.id],
    count: 1,
    people: email.from,
    unread: !email.keywords['$seen'],
    flagged: Boolean(email.keywords['$flagged']),
    hasAttachment: email.hasAttachment,
  }
}

function conversationItem(conversation: Conversation): RowItem {
  return {
    email: conversation.latest,
    ids: conversation.ids,
    count: conversation.messages.length,
    people: conversation.participants,
    unread: conversation.unread,
    flagged: conversation.flagged,
    hasAttachment: conversation.hasAttachment,
  }
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
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        className={`rounded-md p-1.5 transition-colors hover:bg-surface-2 ${active ? 'text-honey' : 'text-ink-muted hover:text-ink'}`}
      >
        <Icon name={icon} size={14} />
      </button>
    </Tooltip>
  )
}

function Row({
  accountId,
  item,
  snippet,
  selected,
  checked,
  inJunk,
  mailboxId,
  onToggleSelect,
  onOpen,
}: {
  accountId: string
  item: RowItem
  snippet?: { subject: string | null; preview: string | null }
  selected: boolean
  checked: boolean
  /** Shows the "not spam" shortcut; only messages filed as junk get it. */
  inJunk: boolean
  /** The folder being listed — what a drag carries as its origin. */
  mailboxId: string
  onToggleSelect: () => void
  onOpen: () => void
}) {
  const { email, ids, unread, flagged } = item
  const sender = email.from[0]
  const { selection, showSnackbar } = useUi()
  /*
   * What archive and delete on this row really take, spelled out in three
   * cases — `ids` is the truth, not the count beside the sender.
   *
   * The count spans folders (your own replies in Sent are part of the
   * exchange); `ids` is only this folder's share of it. So a row can say "4
   * messages" and still have exactly one message here to act on, which is the
   * common shape of an inbox: they wrote once, the rest of the thread is in
   * Sent. That row gets "Archive this message" rather than a bare "Archive" —
   * without it the badge next to the sender reads like a promise the action
   * does not keep.
   */
  const scope = ids.length > 1 ? 'thread' : item.count > 1 ? 'one-of-thread' : 'single'
  const actionLabel = (single: MsgKey, one: MsgKey, thread: MsgKey) =>
    t(scope === 'thread' ? thread : scope === 'one-of-thread' ? one : single)

  // Every action goes through the bulk variants, with a single id when the row
  // is a single message: one code path, and a conversation costs one outbox
  // action carrying its ids rather than one per message.
  const doArchive = () =>
    void bulkArchive(accountId, ids).then((undo) => {
      // null means no Archive mailbox could be created — saying nothing looks
      // exactly like success and leaves the message sitting where it was.
      showSnackbar(
        undo
          ? { message: t('mail.archived'), actionLabel: t('mail.undo'), action: () => void undo() }
          : { message: t('mail.archiveFailed') },
      )
    })
  const doDelete = () =>
    void bulkDelete(accountId, ids).then((undo) => {
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
      /*
       * Dragging a row that is part of the selection takes the whole
       * selection: the row is standing in for it, and moving one message out
       * of a marked group is never what the gesture means. Otherwise it takes
       * the row's own `ids`, which for a conversation is this folder's share
       * of it — the same scope its archive and delete already use.
       */
      draggable
      onDragStart={(e) => setMailDrag(e, { mailboxId, ids: checked ? selection : ids })}
      {...handlers}
      style={dx ? { transform: `translateX(${dx}px)` } : undefined}
      className="group relative mb-1 flex w-full cursor-pointer gap-3 rounded-control px-3 py-3.5 text-left transition-colors duration-100 hover:bg-surface-2 data-checked:bg-accent-wash data-selected:bg-accent-wash"
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
            onClick={() => void bulkSetKeyword(accountId, ids, '$seen', unread)}
          />
          <QuickAction
            icon="flag"
            label={flagged ? t('mail.unflag') : t('mail.flag')}
            active={flagged}
            onClick={() => void bulkSetKeyword(accountId, ids, '$flagged', !flagged)}
          />
          {inJunk && (
            <QuickAction
              icon="inbox"
              label={t('mail.notSpam')}
              onClick={() =>
                void bulkNotSpam(accountId, ids).then((undo) =>
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
          <QuickAction
            icon="archive"
            label={actionLabel('mail.archive', 'mail.archiveMessage', 'mail.archiveThread')}
            onClick={doArchive}
          />
          <QuickAction
            icon="trash"
            label={actionLabel('mail.delete', 'mail.deleteMessage', 'mail.deleteThread')}
            onClick={doDelete}
          />
        </span>

        <span className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span
              className={`min-w-0 truncate text-[13px] ${unread ? 'font-semibold text-ink' : 'font-medium text-ink'}`}
            >
              {senderLabel(item.people)}
            </span>
            {item.count > 1 && (
              <span
                // Spelled out for a screen reader: "3" on its own beside a
                // list of names says nothing about what is being counted.
                aria-label={`${item.count} ${t('mail.messagesCount')}`}
                className="shrink-0 rounded-full bg-surface-2 px-1.5 text-[11px] font-semibold text-ink-muted"
              >
                {item.count}
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-subtle group-hover:lg:invisible">
            {flagged && <Icon name="flag" size={11} className="text-honey" />}
            {item.hasAttachment && <Icon name="paperclip" size={11} />}
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

const BUCKET_LABEL: Record<DateBucket, MsgKey> = {
  today: 'mail.dateToday',
  yesterday: 'mail.dateYesterday',
  thisWeek: 'mail.dateThisWeek',
  older: 'mail.dateOlder',
}

function DateHeader({ bucket }: { bucket: DateBucket }) {
  return (
    <div className="flex items-center gap-2.5 px-3 pt-3 pb-1.5">
      {/* A heading, not a separator: separators carry no text for a screen
          reader, so the buckets would be unreachable and unnamed. */}
      <span
        role="heading"
        aria-level={2}
        className="text-[11px] font-semibold tracking-wider text-ink-muted uppercase"
      >
        {t(BUCKET_LABEL[bucket])}
      </span>
      <span className="h-px flex-1 bg-line-strong" />
    </div>
  )
}

/** A date divider or a row, in list order — one array, so a header can
 *  never disagree with the rows beneath it. */
type ThreadItem =
  { type: 'header'; key: string; bucket: DateBucket } | { type: 'row'; key: string; item: RowItem }

/**
 * Interleaves date dividers into the rows.
 *
 * Deliberately one flat array rather than GroupedVirtuoso's `groupCounts` plus
 * `data`: those are two sources of truth that have to stay in lockstep through
 * every sync tick, and when they drift Virtuoso silently renders fewer rows
 * than it was given — mail goes missing from the list with no error anywhere.
 *
 * Emails arrive newest-first from both the mailbox and search (both sort by
 * receivedAt desc), so each bucket appears at most once.
 */
function withDateHeaders(rows: RowItem[]): ThreadItem[] {
  const items: ThreadItem[] = []
  let last: DateBucket | undefined
  for (const item of rows) {
    const bucket = dateBucket(item.email.receivedAt)
    if (bucket !== last) {
      items.push({ type: 'header', key: `bucket-${bucket}`, bucket })
      last = bucket
    }
    items.push({ type: 'row', key: item.email.id, item })
  }
  return items
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
  conversations,
  snippets,
  mailboxId,
  selectedId,
  onEndReached,
}: {
  accountId: string
  /** One row per message. Ignored when `conversations` is given. */
  emails?: EmailHeader[]
  /** One row per conversation — what the mailbox list passes while grouping
   *  is on. Search results stay per message either way: a search answers with
   *  the messages that matched, not with the threads they sit in. */
  conversations?: Conversation[]
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
  // Memoised for the same reason as the Set above: this walks every loaded row,
  // and the list re-renders on every selection change and every scroll frame.
  const rows = useMemo(
    () => (conversations ? conversations.map(conversationItem) : (emails ?? []).map(messageItem)),
    [conversations, emails],
  )
  const items = useMemo(() => withDateHeaders(rows), [rows])
  const open = (id: string) =>
    void navigate({ to: '/mail/$mailboxId/$emailId', params: { mailboxId, emailId: id } })

  // j/k keyboard navigation (desktop)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return
      if (e.key !== 'j' && e.key !== 'k') return
      // Over the rows as rendered: with conversations that is one step per
      // conversation, not per message, so j/k matches what you see.
      const idx = selectedId ? rows.findIndex((r) => r.email.id === selectedId) : -1
      const next = e.key === 'j' ? Math.min(idx + 1, rows.length - 1) : Math.max(idx - 1, 0)
      // Stepping onto the last loaded row pulls in the next page, so keyboard
      // navigation doesn't stop at the window edge.
      if (e.key === 'j' && next >= rows.length - 1) onEndReached?.()
      const target = rows[next]
      if (target && target.email.id !== selectedId) open(target.email.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!rows.length) {
    return <EmptyState icon="inbox" title={t('mail.noMessages')} hint={t('mail.noMessagesHint')} />
  }

  return (
    <Virtuoso
      className="px-1.5 pb-1.5"
      data={items}
      endReached={onEndReached}
      increaseViewportBy={600}
      computeItemKey={(_, item) => item.key}
      itemContent={(_, item) =>
        item.type === 'header' ? (
          <DateHeader bucket={item.bucket} />
        ) : (
          <Row
            accountId={accountId}
            item={item.item}
            snippet={snippets?.[item.item.email.id]}
            // The row is the selected one when the message open in the reading
            // pane is any of its own — a conversation stays highlighted while
            // you step through the messages inside it.
            selected={item.item.ids.includes(selectedId ?? '')}
            checked={item.item.ids.some((id) => selected.has(id))}
            inJunk={Boolean(junkId && item.item.email.mailboxIds[junkId])}
            mailboxId={mailboxId}
            onToggleSelect={() => toggleSelected(mailboxId, item.item.ids)}
            onOpen={() => open(item.item.email.id)}
          />
        )
      }
    />
  )
}
