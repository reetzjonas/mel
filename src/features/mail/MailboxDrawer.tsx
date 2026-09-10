import { useEffect, useRef } from 'react'
import { useUi } from '../../app/store'
import type { Account } from '../../domain/account'
import type { Mailbox } from '../../domain/mailbox'
import { t } from '../../lib/i18n'
import { Icon } from '../../ui/Icon'
import { scrimClass } from '../../ui/styles'
import { MailboxSidebar } from './MailboxSidebar'

/**
 * The folder list as a drawer, for layouts that have no room for the permanent
 * sidebar: on a phone the sidebar is hidden as soon as a mailbox is open, which
 * otherwise leaves you stuck in whichever folder you happened to enter.
 * Desktop keeps the sidebar and never opens this.
 */
export function MailboxDrawer({ account, mailboxes }: { account: Account; mailboxes: Mailbox[] }) {
  const open = useUi((s) => s.folderDrawerOpen)
  const setOpen = useUi((s) => s.setFolderDrawerOpen)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    // Whatever opened the drawer gets the focus back when it closes, so a
    // keyboard user is not dropped at the top of the document.
    const opener = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      opener?.focus?.()
    }
  }, [open, setOpen])

  if (!open) return null

  return (
    <div className="lg:hidden">
      <div className={scrimClass} onClick={() => setOpen(false)} />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('folder.list')}
        // Picking a folder navigates, so the drawer has done its job. The
        // folder "…" menu stops its own clicks from bubbling, which is what
        // keeps rename/move/delete usable in here.
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a')) setOpen(false)
        }}
        // The drawer covers the mobile bottom bar, so it owes the same
        // safe-area padding the bar has — otherwise the sync status is cut off
        // by the home indicator.
        className="animate-rise fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85%] flex-col bg-raised pb-[env(safe-area-inset-bottom)] shadow-overlay outline-none"
      >
        <div className="flex justify-end px-1 pt-1">
          <button
            type="button"
            aria-label={t('folder.closeList')}
            onClick={() => setOpen(false)}
            className="rounded-control p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <MailboxSidebar account={account} mailboxes={mailboxes} />
        </div>
      </div>
    </div>
  )
}
