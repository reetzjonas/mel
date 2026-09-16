import { useState } from 'react'
import type { Contact, LabeledValue } from '../../domain/contact'
import { t } from '../../lib/i18n'
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../ui/styles'

/*
 * Every field here describes *someone else*, which is why nothing in this form
 * carries a standard autocomplete token. `given-name`, `tel`, `street-address`
 * and friends tell the browser "this is the person filling the form", and it
 * answers by offering the signed-in user's own saved profile — so the one tap
 * that looks helpful writes the user's own address into somebody else's card.
 * `off` plus the absence of any `name` attribute leaves Chrome's heuristics
 * nothing to match on either.
 */
const NO_AUTOFILL = 'off'

function ListField({
  label,
  values,
  onChange,
  type = 'text',
  inputMode,
}: {
  label: string
  values: LabeledValue[]
  onChange: (v: LabeledValue[]) => void
  type?: string
  inputMode?: 'url' | 'tel' | 'email' | 'text'
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-muted">{label}</span>
        {/* Three of these sit on the form and the visible text is the same on
            each, so the field it adds has to be in the name. */}
        <button
          type="button"
          aria-label={`${t('contacts.addField')}: ${label}`}
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
            {...(inputMode ? { inputMode } : {})}
            autoComplete={NO_AUTOFILL}
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
          <input
            className={inputClass}
            autoComplete={NO_AUTOFILL}
            value={c.given}
            onChange={(e) => set({ given: e.target.value })}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-ink-muted">{t('contacts.surname')}</span>
          <input
            className={inputClass}
            autoComplete={NO_AUTOFILL}
            value={c.surname}
            onChange={(e) => set({ surname: e.target.value })}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-ink-muted">{t('contacts.organization')}</span>
          <input
            className={inputClass}
            autoComplete={NO_AUTOFILL}
            value={c.organization}
            onChange={(e) => set({ organization: e.target.value })}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-ink-muted">{t('contacts.jobTitle')}</span>
          <input
            className={inputClass}
            autoComplete={NO_AUTOFILL}
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
      <ListField
        label={t('contacts.phone')}
        type="tel"
        values={c.phones}
        onChange={(phones) => set({ phones })}
      />
      {/* inputMode, not type="url": the URL keyboard is the point, while
          type="url" would also demand a scheme, and a card whose website reads
          "example.com" would refuse to save at all. */}
      <ListField
        label={t('contacts.url')}
        inputMode="url"
        values={c.urls}
        onChange={(urls) => set({ urls })}
      />

      <label className="block space-y-1">
        <span className="text-xs font-medium text-ink-muted">{t('contacts.address')}</span>
        <input
          className={inputClass}
          autoComplete={NO_AUTOFILL}
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
          autoComplete={NO_AUTOFILL}
          value={c.note}
          onChange={(e) => set({ note: e.target.value })}
        />
      </label>

      <div className="flex gap-2">
        <button type="submit" className={primaryButtonClass}>
          {t('contacts.save')}
        </button>
        <button type="button" onClick={onCancel} className={secondaryButtonClass}>
          {t('contacts.cancel')}
        </button>
      </div>
    </form>
  )
}

