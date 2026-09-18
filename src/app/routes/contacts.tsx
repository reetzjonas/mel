import { Link, Outlet, createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useUi } from '../../app/store'
import { displayName, type Contact } from '../../domain/contact'
import { useAccounts } from '../../features/mail/hooks'
import { useContacts } from '../../features/contacts/hooks'
import { CapabilityNotice } from '../../features/settings/ServerCapabilities'
import { t } from '../../lib/i18n'
import { useSelection, type Selection } from '../../lib/selection'
import { deleteContacts } from '../../services/contacts'
import { Avatar } from '../../ui/Avatar'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { ListSkeleton } from '../../ui/Skeleton'
import { SelectionActionButton, SelectionToolbar } from '../../ui/SelectionToolbar'
import { Tooltip } from '../../ui/Tooltip'
import { primaryIconButtonClass, secondaryButtonClass } from '../../ui/styles'

export const Route = createFileRoute('/contacts')({
  component: ContactsLayout,
})

function ContactsLayout() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const contacts = useContacts(account?.id)
  const params = useParams({ strict: false }) as { contactId?: string }
  const navigate = useNavigate()
  const { showSnackbar } = useUi()
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)

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
    if (!account || !window.confirm(t('contacts.delete.selection'))) return
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

  const inDetail = Boolean(params.contactId)

  return (
    <div className="flex h-full gap-0 bg-canvas sm:gap-3 sm:p-3">
      <section
        className={`panel flex h-full w-full min-w-0 flex-col overflow-hidden max-sm:rounded-none max-sm:shadow-none lg:flex lg:w-80 lg:shrink-0 ${inDetail ? 'hidden' : ''}`}
      >
        {checked.size > 0 ? (
          <SelectionToolbar count={checked.size} onClear={clear} busy={busy}>
            <SelectionActionButton
              icon="trash"
              label={t('contacts.delete')}
              disabled={busy}
              onClick={() => void removeChecked()}
            />
          </SelectionToolbar>
        ) : (
          <div className="flex items-center gap-2 px-2.5 pt-2.5 pb-1.5">
            <div className="relative flex-1">
              <Icon
                name="search"
                size={14}
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-subtle"
              />
              <input
                className="w-full rounded-control bg-surface-2 py-2 pr-3 pl-8 text-[13px] outline-none transition-shadow placeholder:text-ink-subtle focus:ring-2 focus:ring-accent"
                placeholder={t('contacts.search')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
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
                className={primaryIconButtonClass}
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
      <div className={`h-full min-w-0 flex-1 lg:block ${inDetail ? '' : 'hidden'}`}>
        <div className="panel h-full overflow-y-auto max-sm:rounded-none max-sm:shadow-none">
          <Outlet />
        </div>
      </div>
    </div>
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
      className="px-1.5 pb-1.5"
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
              className="flex items-center gap-3 rounded-control px-2.5 py-2 transition-colors duration-100 hover:bg-surface-2 data-checked:bg-accent-wash data-selected:bg-accent-wash"
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
                          selecting ? 'flex opacity-100' : 'hidden opacity-0 hover:opacity-100 lg:flex'
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
