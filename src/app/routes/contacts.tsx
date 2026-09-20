import {
  Link,
  Outlet,
  createFileRoute,
  useNavigate,
  useParams,
  useRouterState,
} from '@tanstack/react-router'
import { useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useUi } from '../../app/store'
import { displayName, type Contact } from '../../domain/contact'
import { useAccounts } from '../../features/mail/hooks'
import { useContacts } from '../../features/contacts/hooks'
import { CapabilityNotice } from '../../features/settings/ServerCapabilities'
import { t } from '../../lib/i18n'
import { PANEL_WIDTH_VAR, usePanelWidth, type PanelLimits } from '../../lib/panelWidths'
import { useSelection, type Selection } from '../../lib/selection'
import { deleteContacts } from '../../services/contacts'
import { Avatar } from '../../ui/Avatar'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { MobileFab } from '../../ui/MobileFab'
import { ResizeHandle } from '../../ui/ResizeHandle'
import { SearchInput } from '../../ui/SearchInput'
import { ListSkeleton } from '../../ui/Skeleton'
import { SelectionActionButton, SelectionToolbar } from '../../ui/SelectionToolbar'
import { Tooltip } from '../../ui/Tooltip'
import { primaryIconButtonClass, secondaryButtonClass } from '../../ui/styles'

const LIST_LIMITS: PanelLimits = { min: 240, max: 480, initial: 320 }

export const Route = createFileRoute('/contacts')({
  component: ContactsLayout,
})

function ContactsLayout() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const contacts = useContacts(account?.id)
  const params = useParams({ strict: false }) as { contactId?: string }
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const navigate = useNavigate()
  const { showSnackbar } = useUi()
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const listPanel = usePanelWidth('contacts-list', LIST_LIMITS)
  const listRef = useRef<HTMLElement | null>(null)

  const filtered = useMemo(() => {
    if (!contacts) return undefined
    const needle = filter.trim().toLowerCase()
    if (!needle) return contacts
    return contacts.filter((c) =>
      `${displayName(c)} ${c.emails.map((e) => e.value).join(' ')}`.toLowerCase().includes(needle),
    )
  }, [contacts, filter])

  const selectionRows = useMemo(
    () => (filtered ?? []).map((c) => ({ key: c.id, ids: [c.id] })),
    [filtered],
  )
  const selection = useSelection(selectionRows)
  const { selected: checked, selecting, setSelecting, clear } = selection

  const removeChecked = async () => {
    if (!account) return
    const ids = [...checked]
    clear()
    setBusy(true)
    try {
      await deleteContacts(account.id, ids)
      showSnackbar({ message: t('contacts.deletedSelection') })
      if (params.contactId && ids.includes(params.contactId)) void navigate({ to: '/contacts' })
    } finally {
      setBusy(false)
    }
  }

  if (!account?.capabilities.contacts)
    return <CapabilityNotice reason="caps.unsupported.contacts" />

  // `/contacts/new` is a static child, so it contributes no `contactId` param.
  // It is still a detail screen and must replace the list on compact layouts.
  const inDetail = Boolean(params.contactId) || pathname === '/contacts/new'

  return (
    <>
      <div className="flex h-full gap-0 bg-canvas sm:gap-3 sm:p-3">
        <section
          ref={listRef}
          style={{ [PANEL_WIDTH_VAR]: `${listPanel.width}px` } as React.CSSProperties}
          className={`panel flex h-full w-full min-w-0 flex-col overflow-hidden max-sm:rounded-none max-sm:shadow-none lg:flex lg:w-[var(--mel-panel-w)] lg:shrink-0 ${inDetail ? 'hidden' : ''}`}
        >
          {checked.size > 0 ? (
            <SelectionToolbar count={checked.size} onClear={clear} busy={busy}>
              <SelectionActionButton
                icon="trash"
                label={t('contacts.delete')}
                disabled={busy}
                onClick={() => setConfirmingDelete(true)}
              />
            </SelectionToolbar>
          ) : (
            <div className="flex items-center gap-2 px-2.5 pt-2.5 pb-1.5">
              <SearchInput
                value={filter}
                onChange={setFilter}
                placeholder={t('contacts.search')}
                clearLabel={t('search.clear')}
              />
              <button
                type="button"
                aria-pressed={selecting}
                onClick={() => setSelecting(!selecting)}
                className={`${secondaryButtonClass} ${selecting ? 'bg-surface-2 text-ink' : ''}`}
              >
                {t('contacts.selectToggle')}
              </button>
              <Tooltip label={t('contacts.new')}>
                <button
                  type="button"
                  aria-label={t('contacts.new')}
                  onClick={() => void navigate({ to: '/contacts/new' })}
                  className={`${primaryIconButtonClass} max-sm:hidden`}
                >
                  <Icon name="compose" size={15} />
                </button>
              </Tooltip>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {filtered === undefined ? (
              <ListSkeleton avatar="circle" lines={1} />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon="contact"
                title={filter ? t('contacts.noResults') : t('contacts.empty')}
              />
            ) : (
              <ContactRows
                contacts={filtered}
                selectedId={params.contactId}
                selection={selection}
                selecting={selecting || checked.size > 0}
              />
            )}
          </div>
        </section>
        <ResizeHandle
          limits={LIST_LIMITS}
          label={t('contacts.resizeList')}
          width={listPanel.width}
          targetRef={listRef}
          onCommit={listPanel.commit}
          onReset={listPanel.reset}
        />
        <div className={`h-full min-w-0 flex-1 lg:block ${inDetail ? '' : 'hidden'}`}>
          <div className="panel h-full overflow-y-auto max-sm:rounded-none max-sm:shadow-none">
            <Outlet />
          </div>
        </div>
      </div>
      {!inDetail && !selecting && checked.size === 0 && (
        <MobileFab
          icon="compose"
          label={t('contacts.new')}
          onClick={() => void navigate({ to: '/contacts/new' })}
        />
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title={t('contacts.delete')}
          message={t('contacts.delete.selection')}
          cancelLabel={t('contacts.cancel')}
          confirmLabel={t('contacts.delete')}
          onClose={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false)
            void removeChecked()
          }}
        />
      )}
    </>
  )
}

function ContactRows({
  contacts,
  selectedId,
  selection,
  selecting,
}: {
  contacts: Contact[]
  selectedId?: string
  selection: Selection
  /** Checkboxes pinned visible — turned on explicitly, or once anything is checked. */
  selecting: boolean
}) {
  return (
    <Virtuoso
      className="overflow-x-hidden pb-1.5"
      data={contacts}
      computeItemKey={(_, c) => c.id}
      itemContent={(i, c) => {
        const name = displayName(c)
        const letter = name[0]?.toUpperCase() ?? '#'
        const prev = contacts[i - 1]
        const showHeader = !prev || (displayName(prev)[0]?.toUpperCase() ?? '#') !== letter
        const checked = selection.isSelected(c.id)
        return (
          <div>
            {showHeader && (
              <div className="sticky top-0 z-10 bg-surface/90 px-2.5 py-1 text-[11px] font-semibold tracking-[0.06em] text-ink-subtle uppercase backdrop-blur-sm">
                {letter}
              </div>
            )}
            <Link
              to="/contacts/$contactId"
              params={{ contactId: c.id }}
              data-selected={c.id === selectedId || undefined}
              data-checked={checked || undefined}
              onClick={(e) => {
                if (!selecting) return
                e.preventDefault()
                selection.toggle(c.id, e.shiftKey)
              }}
              className="mx-1.5 flex items-center gap-3 rounded-control px-2.5 py-2 transition-colors duration-100 hover:bg-surface-2 data-checked:bg-accent-wash data-selected:bg-accent-wash"
            >
              {/* The avatar doubles as the checkbox, the way Mail's row does —
                  see ThreadList.tsx — reacting only when the pointer is on the
                  avatar itself, so hovering the row doesn't blank the photo out. */}
              <span className="relative block h-[34px] w-[34px] shrink-0">
                <span className={checked ? 'invisible' : undefined}>
                  <Avatar name={name} email={c.emails[0]?.value ?? name} size={34} src={c.photo} />
                </span>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={`${t('contacts.selectToggle')} ${name}`}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    selection.toggle(c.id, e.shiftKey)
                  }}
                  className={`absolute inset-0 items-center justify-center rounded-full transition-opacity ${
                    checked
                      ? 'flex bg-accent text-accent-ink'
                      : `bg-surface-2 text-ink-muted ring-1 ring-line ring-inset ${
                          selecting
                            ? 'flex opacity-100'
                            : 'hidden opacity-0 hover:opacity-100 lg:flex'
                        }`
                  }`}
                >
                  <Icon name="check" size={18} />
                </button>
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-ink">{name}</span>
                <span className="block truncate text-xs text-ink-subtle">
                  {c.emails[0]?.value ?? c.organization}
                </span>
              </span>
            </Link>
          </div>
        )
      }}
    />
  )
}
