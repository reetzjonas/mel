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
  renameMailbox,
} from '../../services/mailboxes'
import { syncAccount } from '../../sync/engine'
import { Icon, type IconName } from '../../ui/Icon'
import { NameDialog } from '../../ui/NameDialog'
import { mailboxTree } from './mailboxTree'
import { SyncStatus } from './SyncStatus'

const ROLE_ICONS: Record<string, IconName> = {
  inbox: 'inbox',
  drafts: 'draft',
  sent: 'send',
  archive: 'archive',
  junk: 'junk',
  trash: 'trash',
}

type Dialog =
  { kind: 'create'; parentId: string | null } | { kind: 'rename'; mailbox: Mailbox } | null

function FolderMenu({
  mailbox,
  onAction,
}: {
  mailbox: Mailbox
  onAction: (a: 'rename' | 'newSub' | 'delete') => void
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
  const items: Array<['rename' | 'newSub' | 'delete', string, boolean]> = [
    ['rename', t('folder.rename'), custom && mailbox.mayRename],
    ['newSub', t('folder.newSub'), mailbox.mayCreateChild],
    ['delete', t('folder.delete'), custom && mailbox.mayDelete],
  ]
  if (!items.some(([, , enabled]) => enabled)) return null

  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        title={t('folder.menu')}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className="hidden h-5 w-5 shrink-0 items-center justify-center rounded-md text-ink-muted group-hover:inline-flex hover:bg-surface-2 hover:text-ink"
      >
        <Icon name="more" size={13} />
      </button>
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

export function MailboxSidebar({ account, mailboxes }: { account: Account; mailboxes: Mailbox[] }) {
  const accountId = account.id
  const [refreshing, setRefreshing] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const { openCompose, showSnackbar } = useUi()

  const refresh = () => {
    setRefreshing(true)
    void syncAccount(accountId)
      .catch(() => {})
      .finally(() => setRefreshing(false))
  }

  const report = (err: string | null) => {
    if (err) showSnackbar({ message: err })
  }

  const onMenuAction = async (mailbox: Mailbox, action: 'rename' | 'newSub' | 'delete') => {
    if (action === 'rename') return setDialog({ kind: 'rename', mailbox })
    if (action === 'newSub') return setDialog({ kind: 'create', parentId: mailbox.id })

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
        <div className="mb-1.5 flex items-center justify-between pr-1 pl-2.5">
          <span
            className="truncate text-[11px] font-semibold tracking-[0.06em] text-ink-subtle uppercase"
            title={account.label}
          >
            {account.label}
          </span>
          <span className="flex items-center">
            <button
              type="button"
              title={t('folder.new')}
              onClick={() => setDialog({ kind: 'create', parentId: null })}
              className="rounded-md p-1.5 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="folderPlus" size={14} />
            </button>
            <button
              type="button"
              title={t('mail.refresh')}
              onClick={refresh}
              className="rounded-md p-1.5 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="refresh" size={14} className={refreshing ? 'animate-spin' : undefined} />
            </button>
          </span>
        </div>
        <div className="space-y-px">
          {mailboxTree(mailboxes).map(({ mailbox: m, depth }) => (
            <Link
              key={m.id}
              to="/mail/$mailboxId"
              params={{ mailboxId: m.id }}
              className="group flex min-h-[34px] items-center gap-2.5 rounded-control px-2.5 text-[13px] leading-5 text-ink-muted transition-colors duration-100 hover:bg-surface-2 hover:text-ink [&.active]:bg-accent-wash [&.active]:font-medium [&.active]:text-accent"
              style={depth ? { paddingLeft: `${0.625 + depth * 0.85}rem` } : undefined}
            >
              <Icon name={ROLE_ICONS[m.role ?? ''] ?? 'folder'} size={15} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              {m.unreadEmails > 0 && (
                <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-surface-2 px-1.5 text-[11px] font-semibold text-ink-muted group-hover:hidden">
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
