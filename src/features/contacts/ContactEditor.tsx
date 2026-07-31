import { useState } from 'react'
import type { Contact, LabeledValue } from '../../domain/contact'
import { t } from '../../lib/i18n'
import { inputClass } from '../../ui/styles'


function ListField({
  label,
  values,
  onChange,
  type = 'text',
}: {
  label: string
  values: LabeledValue[]
  onChange: (v: LabeledValue[]) => void
  type?: string
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-muted">{label}</span>
        <button
          type="button"
          className="text-xs text-accent"
          onClick={() => onChange([...values, { value: '', label: null }])}
        >
          + {t('contacts.addField')}
        </button>
      </div>
      {values.map((v, i) => (
        <div key={i} className="flex gap-1.5">
          <input
            className={inputClass}
            type={type}
            value={v.value}
            onChange={(e) =>
              onChange(values.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
            }
          />
          <button
            type="button"
            className="px-2 text-ink-muted hover:text-danger"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

export function ContactEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: Contact
  onSave: (c: Contact) => void
  onCancel: () => void
}) {
  const [c, setC] = useState<Contact>(initial)
  const set = (patch: Partial<Contact>) => setC((cur) => ({ ...cur, ...patch }))

  return (
    <form
      className="mx-auto max-w-lg space-y-4 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(c)
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs font-medium text-ink-muted">{t('contacts.given')}</span>
          <input className={inputClass} value={c.given} onChange={(e) => set({ given: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-ink-muted">{t('contacts.surname')}</span>
          <input
            className={inputClass}
            value={c.surname}
            onChange={(e) => set({ surname: e.target.value })}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-ink-muted">{t('contacts.organization')}</span>
          <input
            className={inputClass}
            value={c.organization}
            onChange={(e) => set({ organization: e.target.value })}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-ink-muted">{t('contacts.jobTitle')}</span>
          <input
            className={inputClass}
            value={c.jobTitle}
            onChange={(e) => set({ jobTitle: e.target.value })}
          />
        </label>
      </div>

      <ListField
        label={t('contacts.email')}
        type="email"
        values={c.emails}
        onChange={(emails) => set({ emails })}
      />
      <ListField label={t('contacts.phone')} values={c.phones} onChange={(phones) => set({ phones })} />
      <ListField label={t('contacts.url')} values={c.urls} onChange={(urls) => set({ urls })} />

      <label className="block space-y-1">
        <span className="text-xs font-medium text-ink-muted">{t('contacts.address')}</span>
        <input
          className={inputClass}
          value={c.addresses[0]?.full ?? ''}
          onChange={(e) =>
            set({ addresses: e.target.value ? [{ full: e.target.value, label: null }] : [] })
          }
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-ink-muted">{t('contacts.note')}</span>
        <textarea
          className={`${inputClass} min-h-20`}
          value={c.note}
          onChange={(e) => set({ note: e.target.value })}
        />
      </label>

      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink"
        >
          {t('contacts.save')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-line px-4 py-2 text-sm text-ink-muted hover:text-ink"
        >
          {t('contacts.cancel')}
        </button>
      </div>
    </form>
  )
}

export function emptyContact(addressBookId: string): Contact {
  return {
    id: '',
    addressBookIds: { [addressBookId]: true },
    kind: 'individual',
    fullName: '',
    given: '',
    surname: '',
    nickname: '',
    organization: '',
    jobTitle: '',
    emails: [{ value: '', label: null }],
    phones: [],
    addresses: [],
    urls: [],
    note: '',
    memberUids: [],
  }
}
