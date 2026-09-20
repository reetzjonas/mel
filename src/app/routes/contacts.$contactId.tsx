import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useUi } from '../../app/store'
import { displayName, type LabeledValue } from '../../domain/contact'
import { keyBytes, keyFileName, keyKind, keySize, type ContactKey } from '../../domain/contactKey'
import { ContactEditor } from '../../features/contacts/ContactEditor'
import { useContact } from '../../features/contacts/hooks'
import { birthdayLabel } from '../../features/contacts/birthday'
import { mapHref, profileHref, telHref, webHref } from '../../lib/links'
import { useAccounts, useCanSend } from '../../features/mail/hooks'
import { formatBytes } from '../../lib/bytes'
import { t } from '../../lib/i18n'
import { saveBlob } from '../../lib/saveBlob'
import { deleteContact, updateContact } from '../../services/contacts'
import { Avatar } from '../../ui/Avatar'
import { Icon } from '../../ui/Icon'
import { primaryButtonClass } from '../../ui/styles'

export const Route = createFileRoute('/contacts/$contactId')({
  component: ContactDetail,
})

const actionClass = 'rounded-sm text-sm text-accent hover:underline'

/** What to call a key, by what it turned out to be. */
function keyLabel(key: ContactKey): string {
  const kind = keyKind(key)
  return kind === 'pgp'
    ? t('contacts.key.pgp')
    : kind === 'smime'
      ? t('contacts.key.smime')
      : t('contacts.key.unknown')
}

/**
 * The public keys on a card.
 *
 * Nothing here reads the key — that arrives with the mail side of #63. What it
 * can do is say which kind it is and hand it back out, so a key that reached
 * mel from another client is not trapped in it.
 */
function KeyList({ contact }: { contact: { cryptoKeys: ContactKey[]; name: string } }) {
  if (contact.cryptoKeys.length === 0) return null
  return (
    <div>
      <div className="text-xs font-medium text-ink-muted">{t('contacts.keys')}</div>
      <ul className="mt-1 space-y-1">
        {contact.cryptoKeys.map((key, i) => {
          const bytes = keyBytes(key.uri)
          return (
            <li key={i} className="flex items-center gap-2 text-sm">
              <Icon name="lock" size={13} className="shrink-0 text-ink-muted" />
              <span className="min-w-0 flex-1 truncate">
                {keyLabel(key)}
                <span className="ml-2 text-xs text-ink-muted">
                  {bytes ? formatBytes(keySize(key)) : key.uri}
                </span>
              </span>
              {/* A key the card only points at is a link, not a download: mel
                  would have to fetch it from a third party to save it, and
                  opening a message must not reach out to one. */}
              {bytes ? (
                <button
                  type="button"
                  className={`${actionClass} shrink-0`}
                  aria-label={`${t('contacts.key.download')}: ${keyLabel(key)}`}
                  onClick={() =>
                    saveBlob(
                      new Blob([bytes as BlobPart], {
                        type: key.mediaType || 'application/octet-stream',
                      }),
                      keyFileName(key, contact.name),
                    )
                  }
                >
                  {t('contacts.key.download')}
                </button>
              ) : (
                <a
                  href={key.uri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${actionClass} shrink-0`}
                >
                  {t('contacts.key.open')}
                </a>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * One entry of a contact field, actionable where there is something to do.
 *
 * `href` hands the value to whatever the system opens for it; `onSelect` keeps
 * it inside mel. A value with neither — or one no href could be built from,
 * like a phone field holding "ask Ines" — stays plain text rather than becoming
 * a link that goes nowhere.
 */
function FieldValue({
  value,
  action,
  children,
}: {
  value: string
  action?: { href?: string | null; onSelect?: () => void; describe: string }
  children: React.ReactNode
}) {
  if (action?.onSelect) {
    return (
      <button
        type="button"
        onClick={action.onSelect}
        aria-label={`${action.describe} ${value}`}
        className={`block text-left ${actionClass}`}
      >
        {children}
      </button>
    )
  }
  if (action?.href) {
    return (
      <a
        href={action.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${action.describe} ${value}`}
        className={`block ${actionClass}`}
      >
        {children}
      </a>
    )
  }
  return <div className="text-sm">{children}</div>
}

function FieldList({
  label,
  values,
  action,
}: {
  label: string
  values: LabeledValue[]
  /** Built per entry, so one contact's five numbers each dial their own. */
  action?: (value: string) => { href?: string | null; onSelect?: () => void; describe: string }
}) {
  if (!values.length) return null
  return (
    <div>
      <div className="text-xs font-medium text-ink-muted">{label}</div>
      {values.map((v, i) => (
        <FieldValue key={i} value={v.value} {...(action ? { action: action(v.value) } : {})}>
          {v.value}
          {v.label && <span className="ml-2 text-xs text-ink-muted">({v.label})</span>}
        </FieldValue>
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
  const canSend = useCanSend()
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
      <div className="-mt-2 mb-1 lg:hidden">
        <Link
          to="/contacts"
          className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="back" size={15} />
          {t('mail.back')}
        </Link>
      </div>
      <header className="flex items-center gap-4">
        <Avatar
          name={name}
          email={contact.emails[0]?.value ?? name}
          size={56}
          src={contact.photo}
        />
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
          className="min-h-11 rounded-control border border-line px-3 py-1.5 text-sm transition-colors hover:bg-surface-2 sm:min-h-0"
        >
          {t('contacts.edit')}
        </button>
      </header>

      {canSend && contact.emails.length > 0 && (
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
        <FieldList
          label={t('contacts.email')}
          values={contact.emails}
          // Compose inside mel rather than a mailto: handoff — mel is the mail
          // client here. Without a server that can send, it stays plain text.
          {...(canSend
            ? {
                action: (email: string) => ({
                  onSelect: () => openCompose({ to: [{ name, email }] }),
                  describe: t('contacts.writeTo'),
                }),
              }
            : {})}
        />
        <FieldList
          label={t('contacts.phone')}
          values={contact.phones}
          action={(phone) => ({ href: telHref(phone), describe: t('contacts.call') })}
        />
        <FieldList
          label={t('contacts.url')}
          values={contact.urls}
          action={(url) => ({ href: webHref(url), describe: t('contacts.openLink') })}
        />
        {contact.onlineServices.length > 0 && (
          <div>
            <div className="text-xs font-medium text-ink-muted">{t('contacts.onlineServices')}</div>
            {contact.onlineServices.map((o, i) => {
              // Only a handle that came with a real link is one: mel does not
              // guess a profile URL from "@erika@chaos.social".
              const href = profileHref(o.uri)
              return (
                <FieldValue
                  key={i}
                  value={o.user || o.uri}
                  {...(href ? { action: { href, describe: t('contacts.openProfile') } } : {})}
                >
                  {o.user || o.uri}
                  {o.service && <span className="ml-2 text-xs text-ink-muted">({o.service})</span>}
                </FieldValue>
              )
            })}
          </div>
        )}
        {contact.addresses.length > 0 && (
          <div>
            <div className="text-xs font-medium text-ink-muted">{t('contacts.address')}</div>
            {contact.addresses.map((a, i) => {
              const href = mapHref(a.full)
              return href ? (
                <a
                  key={i}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${t('contacts.showOnMap')} ${a.full}`}
                  className={`block whitespace-pre-line ${actionClass}`}
                >
                  {a.full}
                </a>
              ) : (
                <div key={i} className="text-sm whitespace-pre-line">
                  {a.full}
                </div>
              )
            })}
          </div>
        )}
        {birthdayLabel(contact.birthday) && (
          <div>
            <div className="text-xs font-medium text-ink-muted">{t('contacts.birthday')}</div>
            <div className="text-sm">{birthdayLabel(contact.birthday)}</div>
          </div>
        )}
        {contact.keywords.length > 0 && (
          <div>
            <div className="text-xs font-medium text-ink-muted">{t('contacts.keywords')}</div>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {contact.keywords.map((k) => (
                <li key={k} className="rounded-full bg-surface px-2 py-0.5 text-xs text-ink-muted">
                  {k}
                </li>
              ))}
            </ul>
          </div>
        )}
        <KeyList contact={{ cryptoKeys: contact.cryptoKeys, name }} />
        {contact.note && (
          <div>
            <div className="text-xs font-medium text-ink-muted">{t('contacts.note')}</div>
            <p className="text-sm whitespace-pre-line">{contact.note}</p>
          </div>
        )}
      </div>

      <button
        type="button"
        className="min-h-11 rounded-control px-2 text-sm text-danger hover:bg-danger-wash hover:underline sm:min-h-0"
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
