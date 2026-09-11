import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useUi } from '../../app/store'
import type { Account } from '../../domain/account'
import type { Mailbox } from '../../domain/mailbox'
import { t } from '../../lib/i18n'
import {
  createMailbox,
  deleteMailbox,
  mailboxDeleteCost,
  moveMailbox,
  renameMailbox,
} from '../../services/mailboxes'
import { bulkMove } from '../../services/mailActions'
import { syncAccount } from '../../sync/engine'
import { Icon, type IconName } from '../../ui/Icon'
import { NameDialog } from '../../ui/NameDialog'
import { Tooltip } from '../../ui/Tooltip'
import { overlayPanelClass, secondaryButtonClass } from '../../ui/styles'
import { dragKind, readMailDrag, setFolderDrag } from './dragAndDrop'
import { mailboxTree, moveTargets } from './mailboxTree'
import { SyncStatus } from './SyncStatus'

/** Stands for "no parent" in `dropTarget`, which otherwise holds folder ids. */
const TOP_DROP = '__top__'

const ROLE_ICONS: Record<string, IconName> = {
  inbox: 'inbox',
  drafts: 'draft',
  sent: 'send',
  archive: 'archive',
  junk: 'junk',
  trash: 'trash',
}

type Dialog =
  | { kind: 'create'; parentId: string | null }
  | { kind: 'rename'; mailbox: Mailbox }
  | { kind: 'move'; mailbox: Mailbox }
  | null

function FolderMenu({
  mailbox,
  onAction,
}: {
  mailbox: Mailbox
  onAction: (a: 'rename' | 'newSub' | 'move' | 'delete') => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const custom = mailbox.role === null
  const items: Array<['rename' | 'newSub' | 'move' | 'delete', string, boolean]> = [
    ['rename', t('folder.rename'), custom && mailbox.mayRename],
    // Not under Inbox, Trash and friends: those carry meaning for the server
    // and other clients, and nesting user folders in them invites filters that
    // quietly misfire.
    ['newSub', t('folder.newSub'), custom && mailbox.mayCreateChild],
    // Re-parenting goes through the same Mailbox/set update as renaming, so it
    // is gated on the same right.
    ['move', t('folder.move'), custom && mailbox.mayRename],
    ['delete', t('folder.delete'), custom && mailbox.mayDelete],
  ]
  if (!items.some(([, , enabled]) => enabled)) return null

  return (
    <span ref={ref} className="relative">
      <Tooltip label={t('folder.menu')}>
        <button
          type="button"
          aria-label={t('folder.menu')}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          // `invisible`, not `hidden`: the button keeps its space in the row at
          // all times, so revealing it on hover cannot shove the unread count
          // or the folder name around. visibility:hidden also keeps it
          // unclickable and out of the accessibility tree until it is shown.
          className="invisible inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-ink-muted group-hover:visible hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="more" size={13} />
        </button>
      </Tooltip>
      {open && (
        <span className="animate-rise absolute top-full right-0 z-20 mt-1 w-40 overflow-hidden rounded-control bg-raised py-1 shadow-overlay ring-1 ring-line">
          {items
            .filter(([, , enabled]) => enabled)
            .map(([action, label]) => (
              <button
                key={action}
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setOpen(false)
                  onAction(action)
                }}
                className={`block w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-surface-2 ${action === 'delete' ? 'text-danger' : ''}`}
              >
                {label}
              </button>
            ))}
        </span>
      )}
    </span>
  )
}

/** Target picker for moving a folder. Depth is shown so nesting stays readable. */
function MoveFolderDialog({
  mailbox,
  mailboxes,
  onPick,
  onClose,
}: {
  mailbox: Mailbox
  mailboxes: Mailbox[]
  onPick: (parentId: string | null) => void
  onClose: () => void
}) {
  const targets = moveTargets(mailboxes, mailbox)
  const depthOf = (m: Mailbox) =>
    mailboxTree(mailboxes).find((n) => n.mailbox.id === m.id)?.depth ?? 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className={`animate-rise w-full max-w-xs space-y-2 p-5 ${overlayPanelClass}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold">
          {t('folder.moveTitle')} {mailbox.name}
        </h2>
        <div className="max-h-72 space-y-px overflow-y-auto">
          {mailbox.parentId !== null && (
            <button
              type="button"
              onClick={() => onPick(null)}
              className="block w-full truncate rounded-control px-2 py-1.5 text-left text-sm hover:bg-surface-2"
            >
              {t('folder.moveTop')}
            </button>
          )}
          {targets.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onPick(m.id)}
              className="block w-full truncate rounded-control px-2 py-1.5 text-left text-sm hover:bg-surface-2"
              style={{ paddingLeft: `${0.5 + depthOf(m) * 0.85}rem` }}
            >
              {m.name}
            </button>
          ))}
          {targets.length === 0 && mailbox.parentId === null && (
            <p className="text-xs text-ink-subtle">{t('folder.moveNowhere')}</p>
          )}
        </div>
        <button type="button" onClick={onClose} className={secondaryButtonClass}>
          {t('folder.cancel')}
        </button>
      </div>
    </div>
  )
}

export function MailboxSidebar({ account, mailboxes }: { account: Account; mailboxes: Mailbox[] }) {
  const accountId = account.id
  const [refreshing, setRefreshing] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  /** The folder being dragged, and the row the pointer is currently over. */
  const [dragging, setDragging] = useState<Mailbox | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const { openCompose, showSnackbar, clearSelection } = useUi()

  /*
   * Where the folder in flight may land — the same rule the move dialog
   * offers, so the two paths cannot disagree about what is allowed. Known up
   * front because this component started the drag; the origin of *mail* is
   * not, which is why that one is checked on arrival instead.
   */
  const folderTargets = dragging ? new Set(moveTargets(mailboxes, dragging).map((m) => m.id)) : null

  const endDrag = () => {
    setDragging(null)
    setDropTarget(null)
  }

  /** Whether this row would take what is currently being dragged over it. */
  const takes = (e: React.DragEvent, m: Mailbox) => {
    const kind = dragKind(e)
    if (kind === 'folder') return Boolean(folderTargets?.has(m.id))
    return kind === 'mail' && m.mayAddItems
  }

  const onDropOn = (e: React.DragEvent, m: Mailbox) => {
    e.preventDefault()
    const kind = dragKind(e)
    endDrag()
    if (kind === 'folder') {
      if (dragging && folderTargets?.has(m.id))
        void moveMailbox(accountId, dragging.id, m.id).then(report)
      return
    }
    const payload = readMailDrag(e)
    // Dropping mail back where it came from is a gesture, not a move: the
    // source folder is only readable now, so this is the first chance to say
    // so, and the quietest answer is to do nothing.
    if (!payload || payload.mailboxId === m.id) return
    clearSelection()
    void bulkMove(accountId, payload.ids, m.id).then((undo) =>
      showSnackbar(
        undo
          ? { message: t('bulk.moved'), actionLabel: t('mail.undo'), action: () => void undo() }
          : { message: t('bulk.moved') },
      ),
    )
  }

  const refresh = () => {
    setRefreshing(true)
    void syncAccount(accountId)
      .catch(() => {})
      .finally(() => setRefreshing(false))
  }

  const report = (err: string | null) => {
    if (err) showSnackbar({ message: err })
  }

  const onMenuAction = async (
    mailbox: Mailbox,
    action: 'rename' | 'newSub' | 'move' | 'delete',
  ) => {
    if (action === 'rename') return setDialog({ kind: 'rename', mailbox })
    if (action === 'newSub') return setDialog({ kind: 'create', parentId: mailbox.id })
    if (action === 'move') return setDialog({ kind: 'move', mailbox })

    // Counted on the server, not from our own list: subfolders it knows about
    // and we do not are exactly what makes the delete fail, and totalEmails is
    // right even for mail that was never fetched here.
    const { children, mails } = await mailboxDeleteCost(accountId, mailbox.id)

    const lines = [t('folder.deleteConfirm')]
    if (children) lines.push(`${t('folder.deleteChildren')} (${children})`)
    if (mails) lines.push(`${t('folder.deleteEmails')} (${mails})`)
    if (!confirm(lines.join('\n\n'))) return

    const r = await deleteMailbox(accountId, mailbox.id, {
      recursive: children > 0,
      withEmails: mails > 0,
    })
    report(r.ok ? null : (r.message ?? t('folder.deleteFailed')))
  }

  return (
    <nav className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3 sm:px-0">
        <button
          type="button"
          onClick={() => openCompose({})}
          className="mb-4 hidden items-center justify-center gap-2 rounded-control bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink shadow-raised transition-[background-color,transform] duration-150 hover:bg-accent-hover active:scale-[0.98] lg:flex"
        >
          <Icon name="compose" size={15} />
          {t('compose.new')}
        </button>
        {/*
         * The account row doubles as "top level" while a folder is in flight.
         * Every other destination is a folder, so without it a folder could be
         * dragged in and never out — and a target that only appears mid-drag
         * is both hard to aim at and impossible to hand a drag to, which is
         * how this version was found. The row is always here; only its
         * appearance changes.
         */}
        <div
          onDragOver={(e) => {
            if (dragKind(e) !== 'folder' || !dragging || dragging.parentId === null) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDropTarget(TOP_DROP)
          }}
          onDragLeave={() => setDropTarget((id) => (id === TOP_DROP ? null : id))}
          onDrop={(e) => {
            e.preventDefault()
            const folder = dragging
            endDrag()
            if (folder) void moveMailbox(accountId, folder.id, null).then(report)
          }}
          className={`mb-1.5 flex items-center justify-between rounded-control pr-1 pl-2.5 ${
            dropTarget === TOP_DROP ? 'bg-accent-wash ring-2 ring-accent ring-inset' : ''
          }`}
        >
          <Tooltip label={account.label}>
            <span className="truncate text-[11px] font-semibold tracking-[0.06em] text-ink-subtle uppercase">
              {account.label}
            </span>
          </Tooltip>
          <span className="flex items-center">
            <Tooltip label={t('folder.new')}>
              <button
                type="button"
                aria-label={t('folder.new')}
                onClick={() => setDialog({ kind: 'create', parentId: null })}
                className="rounded-md p-1.5 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <Icon name="folderPlus" size={14} />
              </button>
            </Tooltip>
            <Tooltip label={t('mail.refresh')}>
              <button
                type="button"
                aria-label={t('mail.refresh')}
                onClick={refresh}
                className="rounded-md p-1.5 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <Icon
                  name="refresh"
                  size={14}
                  className={refreshing ? 'animate-spin' : undefined}
                />
              </button>
            </Tooltip>
          </span>
        </div>
        <div className="space-y-px">
          {mailboxTree(mailboxes).map(({ mailbox: m, depth }) => (
            <Link
              key={m.id}
              to="/mail/$mailboxId"
              params={{ mailboxId: m.id }}
              // Only what the menu would also offer to move. Setting it false
              // elsewhere also stops the browser dragging the link's URL,
              // which is never what someone reaching for a folder meant.
              draggable={m.role === null && m.mayRename}
              onDragStart={(e) => {
                setFolderDrag(e, m.id)
                setDragging(m)
              }}
              onDragEnd={endDrag}
              onDragOver={(e) => {
                if (!takes(e, m)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropTarget(m.id)
              }}
              onDragLeave={() => setDropTarget((id) => (id === m.id ? null : id))}
              onDrop={(e) => onDropOn(e, m)}
              /*
               * Spelled out rather than computed from the contents: the row
               * holds an action button, and a labelled button folds its own
               * name into the link's. The link would then be called something
               * different while the pointer is over it, since that button only
               * appears on hover.
               */
              aria-label={m.unreadEmails > 0 ? `${m.name} ${m.unreadEmails}` : m.name}
              className={`group flex min-h-[34px] items-center gap-2.5 rounded-control px-2.5 text-[13px] leading-5 text-ink-muted transition-colors duration-100 hover:bg-surface-2 hover:text-ink [&.active]:bg-accent-wash [&.active]:font-medium [&.active]:text-accent ${
                dropTarget === m.id ? 'bg-accent-wash ring-2 ring-accent ring-inset' : ''
              }`}
              style={depth ? { paddingLeft: `${0.625 + depth * 0.85}rem` } : undefined}
            >
              <Icon name={ROLE_ICONS[m.role ?? ''] ?? 'folder'} size={15} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              {m.unreadEmails > 0 && (
                <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-surface-2 px-1.5 text-[11px] font-semibold text-ink-muted">
                  {m.unreadEmails}
                </span>
              )}
              <FolderMenu mailbox={m} onAction={(a) => void onMenuAction(m, a)} />
            </Link>
          ))}
        </div>
      </div>

      <SyncStatus account={account} />

      {dialog?.kind === 'create' && (
        <NameDialog
          title={dialog.parentId ? t('folder.newSub') : t('folder.new')}
          confirmLabel={t('folder.create')}
          cancelLabel={t('folder.cancel')}
          onClose={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null)
            void createMailbox(accountId, name, dialog.parentId).then(report)
          }}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveFolderDialog
          mailbox={dialog.mailbox}
          mailboxes={mailboxes}
          onClose={() => setDialog(null)}
          onPick={(parentId) => {
            setDialog(null)
            void moveMailbox(accountId, dialog.mailbox.id, parentId).then(report)
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog
          title={t('folder.rename')}
          initial={dialog.mailbox.name}
          confirmLabel={t('folder.save')}
          cancelLabel={t('folder.cancel')}
          onClose={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null)
            void renameMailbox(accountId, dialog.mailbox.id, name).then(report)
          }}
        />
      )}
    </nav>
  )
}
