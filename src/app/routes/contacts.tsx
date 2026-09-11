import { Link, Outlet, createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { displayName, type Contact } from '../../domain/contact'
import { useAccounts } from '../../features/mail/hooks'
import { useContacts } from '../../features/contacts/hooks'
import { useSettingsRoute } from '../../features/settings/navigation'
import { t } from '../../lib/i18n'
import { Avatar } from '../../ui/Avatar'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { Tooltip } from '../../ui/Tooltip'

export const Route = createFileRoute('/contacts')({
  component: ContactsLayout,
})

function ContactsLayout() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const contacts = useContacts(account?.id)
  const params = useParams({ strict: false }) as { contactId?: string }
  const navigate = useNavigate()
  const { open: openSettings } = useSettingsRoute()
  const [filter, setFilter] = useState('')

  const filtered = useMemo(() => {
    if (!contacts) return undefined
    const needle = filter.trim().toLowerCase()
    if (!needle) return contacts
    return contacts.filter((c) =>
      `${displayName(c)} ${c.emails.map((e) => e.value).join(' ')}`.toLowerCase().includes(needle),
    )
  }, [contacts, filter])

  if (!account?.capabilities.contacts) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-muted">
        <p className="text-sm">{t('caps.unsupported.contacts')}</p>
        <button
          type="button"
          onClick={() => openSettings('account')}
          className="text-sm text-accent hover:underline"
        >
          {t('caps.showDetails')}
        </button>
      </div>
    )
  }

  const inDetail = Boolean(params.contactId)

  return (
    <div className="flex h-full gap-0 bg-canvas sm:gap-3 sm:p-3">
      <section
        className={`panel flex h-full w-full min-w-0 flex-col overflow-hidden max-sm:rounded-none max-sm:shadow-none lg:flex lg:w-80 lg:shrink-0 ${inDetail ? 'hidden' : ''}`}
      >
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
          <Tooltip label={t('contacts.new')}>
            <button
              type="button"
              aria-label={t('contacts.new')}
              onClick={() => void navigate({ to: '/contacts/new' })}
              className="rounded-control bg-accent p-2 text-accent-ink shadow-raised transition-[background-color,transform] duration-150 hover:bg-accent-hover active:scale-95"
            >
              <Icon name="compose" size={15} />
            </button>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1">
          {filtered === undefined ? null : filtered.length === 0 ? (
            <EmptyState
              icon="contact"
              title={filter ? t('contacts.noResults') : t('contacts.empty')}
            />
          ) : (
            <ContactRows contacts={filtered} selectedId={params.contactId} />
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

function ContactRows({ contacts, selectedId }: { contacts: Contact[]; selectedId?: string }) {
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
              className="flex items-center gap-3 rounded-control px-2.5 py-2 transition-colors duration-100 hover:bg-surface-2 data-selected:bg-accent-wash"
            >
              <Avatar name={name} email={c.emails[0]?.value ?? name} size={34} />
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
