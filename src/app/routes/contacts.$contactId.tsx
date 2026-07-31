import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useUi } from '../../app/store'
import { displayName, type LabeledValue } from '../../domain/contact'
import { ContactEditor } from '../../features/contacts/ContactEditor'
import { useContact } from '../../features/contacts/hooks'
import { useAccounts } from '../../features/mail/hooks'
import { t } from '../../lib/i18n'
import { deleteContact, updateContact } from '../../services/contacts'
import { Avatar } from '../../ui/Avatar'
import { Icon } from '../../ui/Icon'
import { primaryButtonClass } from '../../ui/styles'

export const Route = createFileRoute('/contacts/$contactId')({
  component: ContactDetail,
})

function FieldList({ label, values }: { label: string; values: LabeledValue[] }) {
  if (!values.length) return null
  return (
    <div>
      <div className="text-xs font-medium text-ink-muted">{label}</div>
      {values.map((v, i) => (
        <div key={i} className="text-sm">
          {v.value}
          {v.label && <span className="ml-2 text-xs text-ink-muted">({v.label})</span>}
        </div>
      ))}
    </div>
  )
}

function ContactDetail() {
  const { contactId } = Route.useParams()
  const accounts = useAccounts()
  const account = accounts?.[0]
  const contact = useContact(account?.id, contactId)
  const navigate = useNavigate()
  const { openCompose, showSnackbar } = useUi()
  const [editing, setEditing] = useState(false)

  if (!account || contact === undefined) return null
  if (contact === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-muted">
        {t('contacts.notFound')}
      </div>
    )
  }

  if (editing) {
    return (
      <ContactEditor
        initial={contact}
        onCancel={() => setEditing(false)}
        onSave={(c) => {
          const cleaned = { ...c, emails: c.emails.filter((e) => e.value.trim()) }
          void updateContact(account.id, cleaned).then(() => setEditing(false))
        }}
      />
    )
  }

  const name = displayName(contact)

  return (
    <article className="mx-auto max-w-lg space-y-4 p-4">
      <div className="mb-2 lg:hidden">
        <Link
          to="/contacts"
          className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-ink-muted hover:bg-surface-2"
        >
          <Icon name="back" size={15} />
          {t('mail.back')}
        </Link>
      </div>
      <header className="flex items-center gap-4">
        <Avatar name={name} email={contact.emails[0]?.value ?? name} size={56} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{name}</h1>
          {(contact.jobTitle || contact.organization) && (
            <p className="truncate text-sm text-ink-muted">
              {[contact.jobTitle, contact.organization].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded-control border border-line px-3 py-1.5 text-sm transition-colors hover:bg-surface-2"
        >
          {t('contacts.edit')}
        </button>
      </header>

      {contact.emails.length > 0 && (
        <button
          type="button"
          className={`flex items-center gap-2 ${primaryButtonClass}`}
          onClick={() =>
            openCompose({
              to: contact.emails.slice(0, 1).map((e) => ({ name, email: e.value })),
            })
          }
        >
          <Icon name="send" size={14} />
          {t('contacts.sendMail')}
        </button>
      )}

      <div className="space-y-3 rounded-panel bg-surface-2/50 p-4">
        <FieldList label={t('contacts.email')} values={contact.emails} />
        <FieldList label={t('contacts.phone')} values={contact.phones} />
        <FieldList label={t('contacts.url')} values={contact.urls} />
        {contact.addresses.length > 0 && (
          <div>
            <div className="text-xs font-medium text-ink-muted">{t('contacts.address')}</div>
            {contact.addresses.map((a, i) => (
              <div key={i} className="text-sm whitespace-pre-line">
                {a.full}
              </div>
            ))}
          </div>
        )}
        {contact.note && (
          <div>
            <div className="text-xs font-medium text-ink-muted">{t('contacts.note')}</div>
            <p className="text-sm whitespace-pre-line">{contact.note}</p>
          </div>
        )}
      </div>

      <button
        type="button"
        className="text-sm text-danger hover:underline"
        onClick={() => {
          void deleteContact(account.id, contact.id).then(() => {
            showSnackbar({ message: t('contacts.deleted') })
            void navigate({ to: '/contacts' })
          })
        }}
      >
        {t('contacts.delete')}
      </button>
    </article>
  )
}
