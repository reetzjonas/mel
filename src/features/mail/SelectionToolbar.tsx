import { useState } from 'react'
import { useUi } from '../../app/store'
import type { Mailbox } from '../../domain/mailbox'
import { t } from '../../lib/i18n'
import { bulkArchive, bulkDelete, bulkMove, bulkSetKeyword } from '../../services/mailActions'
import { connectionFor } from '../../sync/connections'
import { Icon, type IconName } from '../../ui/Icon'

/** Ceiling for "select everything in this folder"; anything beyond is reported, not hidden. */
const SELECT_ALL_LIMIT = 50_000

function ToolbarButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: IconName
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
    >
      <Icon name={icon} size={15} />
    </button>
  )
}

/**
 * Actions for the current multi-selection. Replaces the search row while a
 * selection exists, so it can't be missed and doesn't add permanent chrome.
 */
export function SelectionToolbar({
  accountId,
  mailboxId,
  mailboxes,
}: {
  accountId: string
  mailboxId: string
  mailboxes: Mailbox[]
}) {
  const { selection, setSelection, clearSelection, showSnackbar } = useUi()
  const [busy, setBusy] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const count = selection.length

  async function run(action: () => Promise<(() => Promise<void>) | null | void>, message: string) {
    setBusy(true)
    try {
      const undo = await action()
      clearSelection()
      showSnackbar(
        typeof undo === 'function'
          ? { message, actionLabel: t('mail.undo'), action: () => void undo() }
          : { message },
      )
    } finally {
      setBusy(false)
    }
  }

  /** Server-side: the locally cached ids are only what happens to be synced. */
  async function selectWholeFolder() {
    setBusy(true)
    try {
      const conn = await connectionFor(accountId)
      const r = await conn.mail?.queryMailboxIds(mailboxId, SELECT_ALL_LIMIT)
      if (!r?.ids.length) return
      setSelection(mailboxId, r.ids)
      // Say so when the folder is larger than the ceiling, rather than quietly
      // acting on the newest slice and leaving the rest behind.
      if (r.total > r.ids.length) {
        showSnackbar({ message: `${t('bulk.cappedAt')} ${r.ids.length} / ${r.total}` })
      }
    } catch {
      showSnackbar({ message: t('bulk.selectAllFailed') })
    } finally {
      setBusy(false)
    }
  }

  const targets = mailboxes.filter((m) => m.id !== mailboxId)

  return (
    <div className="px-2.5 pt-2.5 pb-1.5" data-testid="selection-toolbar">
      <div className="flex items-center gap-1">
        <button
          type="button"
          title={t('bulk.clear')}
          aria-label={t('bulk.clear')}
          onClick={clearSelection}
          className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="close" size={15} />
        </button>
        <span className="text-[13px] font-medium whitespace-nowrap">
          {count} {t('bulk.selected')}
        </span>

        <span className="ml-auto flex items-center">
          <ToolbarButton
            icon="mail"
            label={t('mail.markRead')}
            disabled={busy}
            onClick={() =>
              void run(() => bulkSetKeyword(accountId, selection, '$seen', true), t('bulk.marked'))
            }
          />
          <ToolbarButton
            icon="mailUnread"
            label={t('mail.markUnread')}
            disabled={busy}
            onClick={() =>
              void run(() => bulkSetKeyword(accountId, selection, '$seen', false), t('bulk.marked'))
            }
          />
          <ToolbarButton
            icon="flag"
            label={t('mail.flag')}
            disabled={busy}
            onClick={() =>
              void run(
                () => bulkSetKeyword(accountId, selection, '$flagged', true),
                t('bulk.marked'),
              )
            }
          />
          <span className="relative">
            <ToolbarButton
              icon="folder"
              label={t('bulk.move')}
              disabled={busy}
              onClick={() => setMoveOpen((o) => !o)}
            />
            {moveOpen && (
              <span className="animate-rise absolute top-full right-0 z-20 mt-1 max-h-64 w-48 overflow-y-auto rounded-control bg-raised py-1 shadow-overlay ring-1 ring-line">
                {targets.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="block w-full truncate px-3 py-1.5 text-left text-sm transition-colors hover:bg-surface-2"
                    onClick={() => {
                      setMoveOpen(false)
                      void run(() => bulkMove(accountId, selection, m.id), t('bulk.moved'))
                    }}
                  >
                    {m.name}
                  </button>
                ))}
              </span>
            )}
          </span>
          <ToolbarButton
            icon="archive"
            label={t('mail.archive')}
            disabled={busy}
            onClick={() => void run(() => bulkArchive(accountId, selection), t('mail.archived'))}
          />
          <ToolbarButton
            icon="trash"
            label={t('mail.delete')}
            disabled={busy}
            onClick={() => void run(() => bulkDelete(accountId, selection), t('mail.deleted'))}
          />
        </span>
      </div>

      {/*
        Its own line: the actions are the point of this bar and must stay
        reachable, and the label is far too long to share a 24rem-wide panel
        with six icon buttons. Offered from the first tick onwards — making
        someone tick every row by hand first defeats the shortcut.
      */}
      <button
        type="button"
        onClick={() => void selectWholeFolder()}
        disabled={busy}
        className="mt-0.5 ml-8 block text-xs text-accent hover:underline disabled:opacity-40"
      >
        {busy ? t('bulk.selectingAll') : t('bulk.selectAll')}
      </button>
    </div>
  )
}
