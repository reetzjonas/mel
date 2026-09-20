import { useRef, useState } from 'react'
import { useUi } from '../../app/store'
import type { MailFilter } from '../../domain/email'
import type { Mailbox } from '../../domain/mailbox'
import { t } from '../../lib/i18n'
import type { Selection } from '../../lib/selection'
import {
  bulkArchive,
  bulkDelete,
  bulkMove,
  bulkNotSpam,
  bulkSetKeyword,
} from '../../services/mailActions'
import { connectionFor } from '../../sync/connections'
import {
  SelectionActionButton,
  SelectionToolbar as SharedSelectionToolbar,
} from '../../ui/SelectionToolbar'
import { OverflowMenu, type OverflowAction } from '../../ui/OverflowMenu'
import { usePopover } from '../../ui/usePopover'

/** Ceiling for "select everything in this folder"; anything beyond is reported, not hidden. */
const SELECT_ALL_LIMIT = 50_000

/**
 * Actions for the current multi-selection. Replaces the search row while a
 * selection exists, so it can't be missed and doesn't add permanent chrome.
 */
export function SelectionToolbar({
  accountId,
  mailboxId,
  mailboxes,
  filter,
  selection,
}: {
  accountId: string
  mailboxId: string
  mailboxes: Mailbox[]
  /** The list's active filter, so "select everything" means what is on screen. */
  filter?: MailFilter
  /** Owned by `mail.$mailboxId.tsx`, which also renders the sibling
   *  `ThreadList` — see `lib/selection.ts`. */
  selection: Selection
}) {
  const { showSnackbar } = useUi()
  const [busy, setBusy] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const movePicker = useRef<HTMLSpanElement>(null)
  const ids = [...selection.selected]
  const count = ids.length

  async function run(
    action: () => Promise<(() => Promise<void>) | null | void>,
    message: string,
    /** Shown when the action reports it could not do anything. */
    failMessage?: string,
  ) {
    setBusy(true)
    try {
      const undo = await action()
      selection.clear()
      if (typeof undo === 'function') {
        showSnackbar({ message, actionLabel: t('mail.undo'), action: () => void undo() })
      } else {
        showSnackbar({ message: undo === null && failMessage ? failMessage : message })
      }
    } finally {
      setBusy(false)
    }
  }

  /** Server-side: the locally cached ids are only what happens to be synced. */
  async function selectWholeFolder() {
    setBusy(true)
    try {
      const conn = await connectionFor(accountId)
      const r = await conn.mail?.queryMailboxIds(mailboxId, SELECT_ALL_LIMIT, filter)
      if (!r?.ids.length) return
      selection.setSelected(r.ids)
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
  const inJunk = mailboxes.find((m) => m.id === mailboxId)?.role === 'junk'

  usePopover({ panel: movePicker, onClose: () => setMoveOpen(false), enabled: moveOpen })

  const moreActions: OverflowAction[] = [
    ...(inJunk
      ? [
          {
            icon: 'inbox' as const,
            label: t('mail.notSpam'),
            disabled: busy,
            onSelect: () =>
              void run(
                () => bulkNotSpam(accountId, ids),
                t('mail.movedToInbox'),
                t('mail.notSpamFailed'),
              ),
          },
        ]
      : []),
    {
      icon: 'mail',
      label: t('mail.markRead'),
      disabled: busy,
      onSelect: () =>
        void run(() => bulkSetKeyword(accountId, ids, '$seen', true), t('bulk.marked')),
    },
    {
      icon: 'mailUnread',
      label: t('mail.markUnread'),
      disabled: busy,
      onSelect: () =>
        void run(() => bulkSetKeyword(accountId, ids, '$seen', false), t('bulk.marked')),
    },
    {
      icon: 'flag',
      label: t('mail.flag'),
      disabled: busy,
      onSelect: () =>
        void run(() => bulkSetKeyword(accountId, ids, '$flagged', true), t('bulk.marked')),
    },
  ]

  return (
    <SharedSelectionToolbar
      count={count}
      onClear={selection.clear}
      busy={busy}
      onSelectAll={() => void selectWholeFolder()}
      selectAllLabel={busy ? t('bulk.selectingAll') : t('bulk.selectAll')}
    >
      <OverflowMenu label={t('bulk.moreActions')} actions={moreActions} />
      <span ref={movePicker} className="relative">
        <SelectionActionButton
          icon="folder"
          label={t('bulk.move')}
          disabled={busy}
          onClick={() => setMoveOpen((o) => !o)}
        />
        {moveOpen && (
          <span
            data-testid="move-folder-picker"
            className="animate-rise absolute top-full right-0 z-20 mt-1 flex max-h-64 w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-control bg-raised shadow-overlay ring-1 ring-line"
          >
            <span className="shrink-0 border-b border-line px-4 py-3">
              <span className="block text-center text-sm font-semibold">{t('bulk.move')}</span>
            </span>
            <span className="min-h-0 overflow-y-auto p-2">
              {targets.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="block w-full truncate rounded-control px-2 py-2 text-left text-sm transition-colors hover:bg-surface-2"
                  onClick={() => {
                    setMoveOpen(false)
                    void run(() => bulkMove(accountId, ids, m.id), t('bulk.moved'))
                  }}
                >
                  {m.name}
                </button>
              ))}
            </span>
          </span>
        )}
      </span>
      <SelectionActionButton
        icon="archive"
        label={t('mail.archive')}
        disabled={busy}
        onClick={() =>
          void run(() => bulkArchive(accountId, ids), t('mail.archived'), t('mail.archiveFailed'))
        }
      />
      <SelectionActionButton
        icon="trash"
        label={t('mail.delete')}
        disabled={busy}
        onClick={() => void run(() => bulkDelete(accountId, ids), t('mail.deleted'))}
      />
    </SharedSelectionToolbar>
  )
}
