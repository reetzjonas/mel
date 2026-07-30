import { Link, Outlet, createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { displayName, type Contact } from '../../domain/contact'
import { useAccounts } from '../../features/mail/hooks'
import { useContacts } from '../../features/contacts/hooks'
import { t } from '../../lib/i18n'
import { Avatar } from '../../ui/Avatar'
import { Icon } from '../../ui/Icon'

export const Route = createFileRoute('/contacts')({
  component: ContactsLayout,
})

function ContactsLayout() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const contacts = useContacts(account?.id)
  const params = useParams({ strict: false }) as { contactId?: string }
  const navigate = useNavigate()
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
      <div className="flex h-full items-center justify-center text-ink-muted">
        {t('app.comingSoon.contacts')}
      </div>
    )
  }

  const inDetail = Boolean(params.contactId)

  return (
    <div className="flex h-full">
      <section
        className={`flex h-full w-full min-w-0 flex-col border-r border-line lg:flex lg:w-80 lg:shrink-0 ${inDetail ? 'hidden' : ''}`}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <div className="relative flex-1">
            <Icon
              name="search"
              size={14}
              className="absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-muted"
            />
            <input
              className="w-full rounded-lg bg-surface-2 py-1.5 pr-3 pl-8 text-sm outline-none placeholder:text-ink-muted/70 focus:ring-1 focus:ring-accent"
              placeholder={t('contacts.search')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <button
            type="button"
            title={t('contacts.new')}
            onClick={() => void navigate({ to: '/contacts/new' })}
            className="rounded-lg bg-accent p-2 text-accent-ink"
          >
            <Icon name="compose" size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {filtered === undefined ? null : filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-ink-muted">
              {filter ? t('contacts.noResults') : t('contacts.empty')}
            </div>
          ) : (
            <ContactRows contacts={filtered} selectedId={params.contactId} />
          )}
        </div>
      </section>
      <div className={`h-full min-w-0 flex-1 overflow-y-auto lg:block ${inDetail ? '' : 'hidden'}`}>
        <Outlet />
      </div>
    </div>
  )
}

function ContactRows({ contacts, selectedId }: { contacts: Contact[]; selectedId?: string }) {
  return (
    <Virtuoso
      data={contacts}
      computeItemKey={(_, c) => c.id}
      itemContent={(i, c) => {
        const name = displayName(c)
        const letter = name[0]?.toUpperCase() ?? '#'
        const prev = contacts[i - 1]
        const showHeader = !prev || (displayName(prev)[0]?.toUpperCase() ?? '#') !== letter
        return (
          <div className="bg-bg">
            {showHeader && (
              <div className="sticky top-0 border-b border-line bg-surface px-4 py-1 text-xs font-semibold text-ink-muted">
                {letter}
              </div>
            )}
            <Link
              to="/contacts/$contactId"
              params={{ contactId: c.id }}
              data-selected={c.id === selectedId || undefined}
              className="flex items-center gap-3 border-b border-line px-4 py-2.5 hover:bg-surface-2 data-selected:bg-accent/10"
            >
              <Avatar name={name} email={c.emails[0]?.value ?? name} size={32} />
              <span className="min-w-0">
                <span className="block truncate text-sm">{name}</span>
                <span className="block truncate text-xs text-ink-muted">
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
