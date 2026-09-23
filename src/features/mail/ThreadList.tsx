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
import type { Selection } from '../../lib/selection'
import { useContactsByEmail, useMailboxes, useUndeliveredIds, type ContactByEmail } from './hooks'
import { conversationItem, messageItem, type RowItem } from './rowItem'
import { bulkArchive, bulkDelete, bulkNotSpam, bulkSetKeyword } from '../../services/mailActions'
import { Avatar } from '../../ui/Avatar'
import {
  clearDragState,
  draggableTouchClass,
  setMailDrag,
  suppressContextMenu,
} from '../../lib/dragAndDrop'
import { EmptyState } from '../../ui/EmptyState'
import { Icon, type IconName } from '../../ui/Icon'
import { Tooltip } from '../../ui/Tooltip'

function senderLabel(from: EmailAddress[]): string {
  if (!from.length) return t('mail.unknownSender')
  return from.map((a) => a.name || a.email.split('@')[0]).join(', ')
}

/*
 * How far across the row a swipe has to travel before letting go acts.
 *
 * A fraction of the row rather than a fixed distance: "far enough to mean it"
 * is how much of the row has been pushed aside, which a phone-width and a
 * tablet-width list disagree about in pixels. The value is deliberately most
 * of the way to the edge — archive and delete are easy to fire by accident
 * while scrolling a list with the thumb, and the undo snackbar is a poor
 * substitute for not triggering them. `SWIPE_TRIGGER_MIN_PX` keeps a narrow
 * row from making the gesture trivially short.
 */
const SWIPE_TRIGGER_FRACTION = 0.45
const SWIPE_TRIGGER_MIN_PX = 120

/** Touch swipe: right = archive, left = delete. */
function useSwipe(onArchive: () => void, onDelete: () => void) {
  const [dx, setDx] = useState(0)
  const start = useRef<{ x: number; y: number } | null>(null)
  const [trigger, setTrigger] = useState(SWIPE_TRIGGER_MIN_PX)
  const wasArmed = useRef(false)

  return {
    dx,
    progress: Math.min(1, Math.abs(dx) / trigger),
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        const touch = e.touches[0]
        if (!touch) return
        start.current = { x: touch.clientX, y: touch.clientY }
        setTrigger(
          Math.max(SWIPE_TRIGGER_MIN_PX, e.currentTarget.clientWidth * SWIPE_TRIGGER_FRACTION),
        )
      },
      onTouchMove: (e: React.TouchEvent) => {
        const touch = e.touches[0]
        if (!start.current || !touch) return
        const deltaX = touch.clientX - start.current.x
        const deltaY = touch.clientY - start.current.y
        if (Math.abs(deltaX) <= 12 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return
        setDx(deltaX)
        // A tap on crossing the line, so the thumb is told as well as the eye —
        // the finger is usually covering the row it is dragging. Android only
        // in practice; iOS Safari has no Vibration API and simply skips it.
        const armed = Math.abs(deltaX) >= trigger
        if (armed !== wasArmed.current) {
          wasArmed.current = armed
          if (armed) navigator.vibrate?.(10)
        }
      },
      onTouchEnd: () => {
        if (dx > trigger) onArchive()
        else if (dx < -trigger) onDelete()
        setDx(0)
        wasArmed.current = false
        start.current = null
      },
    },
  }
}

/**
 * The strip a swipe uncovers, in the direction it is heading.
 *
 * Exactly as wide as the row has moved, so it only ever occupies the space the
 * row vacates — the row itself can stay translucent (a checked row is tinted
 * with a semi-transparent wash) without this bleeding through it.
 *
 * Crossing the trigger distance is a state, not a gradient: up to it the strip
 * is only a tint and the icon grows, at it the colour goes solid and the
 * action names itself. Letting go is irreversible enough (and the row is under
 * the thumb) that "will this fire?" should not be a judgement of shade.
 */
function SwipeHint({ dx, progress }: { dx: number; progress: number }) {
  const archive = dx > 0
  const armed = progress >= 1
  const tone = archive
    ? armed
      ? 'left-0 bg-honey text-canvas'
      : 'left-0 bg-honey/20 text-honey'
    : armed
      ? 'right-0 bg-danger text-canvas'
      : 'right-0 bg-danger/20 text-danger'
  return (
    <span
      aria-hidden
      style={{ width: Math.abs(dx) }}
      className={`absolute inset-y-0 flex items-center justify-center gap-2 overflow-hidden transition-colors duration-150 ${tone}`}
    >
      <span
        className="transition-transform duration-150"
        style={{
          opacity: 0.4 + progress * 0.6,
          transform: `scale(${armed ? 1.15 : 0.6 + progress * 0.4})`,
        }}
      >
        <Icon name={archive ? 'archive' : 'trash'} size={18} />
      </span>
      {armed && (
        <span className="text-xs font-semibold whitespace-nowrap">
          {t(archive ? 'mail.archive' : 'mail.delete')}
        </span>
      )}
    </span>
  )
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
  selectedIds,
  inJunk,
  mailboxId,
  photos,
  undelivered,
  onToggleSelect,
  onOpen,
}: {
  accountId: string
  item: RowItem
  snippet?: { subject: string | null; preview: string | null }
  selected: boolean
  checked: boolean
  /** The whole current selection, for a checked row's drag payload. */
  selectedIds: string[]
  /** Shows the "not spam" shortcut; only messages filed as junk get it. */
  inJunk: boolean
  /** The folder being listed — what a drag carries as its origin. */
  mailboxId: string
  /** Sender email → contact, looked up once for the whole list. */
  photos: Map<string, ContactByEmail> | undefined
  /** A recipient refused one of the row's messages (issue #70). */
  undelivered: boolean
  onToggleSelect: (extend: boolean) => void
  onOpen: () => void
}) {
  const { email, ids, unread, flagged } = item
  const sender = email.from[0]
  const { showSnackbar } = useUi()
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

  const { dx, progress, handlers } = useSwipe(doArchive, doDelete)

  return (
    <div className="relative mb-1 overflow-hidden rounded-control">
      {dx !== 0 && <SwipeHint dx={dx} progress={progress} />}
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
        onDragStart={(e) =>
          setMailDrag(
            e,
            { mailboxId, ids: checked ? selectedIds : ids },
            checked && selectedIds.length > 1
              ? `${selectedIds.length} ${t('bulk.selected')}`
              : email.subject || t('mail.noSubject'),
          )
        }
        onDragEnd={clearDragState}
        onContextMenu={suppressContextMenu}
        {...handlers}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        className={`group relative flex w-full cursor-pointer gap-3 rounded-control px-3 py-2 text-left transition-colors duration-100 hover:bg-surface-2 data-checked:bg-accent-wash data-selected:bg-accent-wash ${draggableTouchClass}`}
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
                src={sender?.email ? photos?.get(sender.email.toLowerCase())?.photo : undefined}
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
                onToggleSelect(e.shiftKey)
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
              {undelivered && (
                <span role="img" aria-label={t('mail.notDelivered')} title={t('mail.notDelivered')}>
                  <Icon name="warning" size={11} className="text-danger" />
                </span>
              )}
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
  selection,
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
  /** Owned by `mail.$mailboxId.tsx`, which also renders the sibling
   *  `SelectionToolbar` — see `lib/selection.ts`. */
  selection: Selection
  /** Materialise the next page; omitted when the list is already complete. */
  onEndReached?: (() => void) | undefined
}) {
  const navigate = useNavigate()
  const mailboxes = useMailboxes(accountId)
  const contacts = useContactsByEmail(accountId)
  const undelivered = useUndeliveredIds(accountId)
  const junkId = mailboxes?.find((m) => m.role === 'junk')?.id
  const selectedIds = useMemo(() => [...selection.selected], [selection.selected])
  // Memoised for the same reason `selected` above is a Set, not the array:
  // this walks every loaded row, and the list re-renders on every selection
  // change and every scroll frame.
  const rows = useMemo(
    () => (conversations ? conversations.map(conversationItem) : (emails ?? []).map(messageItem)),
    [conversations, emails],
  )
  const items = useMemo(() => withDateHeaders(rows), [rows])

  // Carries the search along: opening a message must not drop the query or
  // filter the list was showing, or the back button lands on an unfiltered one.
  const open = (id: string) =>
    void navigate({
      to: '/mail/$mailboxId/$emailId',
      params: { mailboxId, emailId: id },
      search: (prev) => prev,
    })

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
      className="min-w-0 overflow-x-hidden pb-1.5"
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
            checked={item.item.ids.some((id) => selection.isSelected(id))}
            selectedIds={selectedIds}
            inJunk={Boolean(junkId && item.item.email.mailboxIds[junkId])}
            mailboxId={mailboxId}
            photos={contacts}
            undelivered={Boolean(undelivered && item.item.ids.some((id) => undelivered.has(id)))}
            onToggleSelect={(extend) => selection.toggle(item.item.email.id, extend)}
            onOpen={() => open(item.item.email.id)}
          />
        )
      }
    />
  )
}
