import { currentLocale, t, type MsgKey } from '../../lib/i18n'
import {
  DAY_CODES,
  repeatError,
  type Frequency,
  type RepeatEnd,
  type RepeatForm,
} from '../../lib/recurrenceForm'
import { Select } from '../../ui/Select'
import { inputClass } from '../../ui/styles'

const UNITS: Record<Frequency, [one: MsgKey, many: MsgKey]> = {
  daily: ['cal.repeat.day', 'cal.repeat.days'],
  weekly: ['cal.repeat.week', 'cal.repeat.weeks'],
  monthly: ['cal.repeat.month', 'cal.repeat.months'],
  yearly: ['cal.repeat.year', 'cal.repeat.years'],
}

const ENDS: Array<[RepeatEnd, MsgKey]> = [
  ['never', 'cal.repeat.end.never'],
  ['count', 'cal.repeat.end.count'],
  ['until', 'cal.repeat.end.until'],
]

const weekday = new Intl.DateTimeFormat(currentLocale, { weekday: 'short' })

/** Short weekday names in the reader's language, Monday first (2026-08-03 is one). */
const DAY_LABELS = DAY_CODES.map((_, i) => weekday.format(new Date(Date.UTC(2026, 7, 3 + i, 12))))

/**
 * The repeat controls: frequency, "every N", weekdays and when it stops.
 *
 * Only the frequency is always shown; the rest appears once the event repeats,
 * so a one-off event's dialog stays as short as it was.
 */
export function RecurrenceField({
  value,
  startDate,
  onChange,
}: {
  value: RepeatForm
  startDate: string
  onChange: (next: RepeatForm) => void
}) {
  const error = repeatError(value, startDate)
  const frequency = value.frequency

  function toggleDay(code: string) {
    const byDay = value.byDay.includes(code)
      ? value.byDay.filter((d) => d !== code)
      : [...value.byDay, code]
    onChange({ ...value, byDay })
  }

  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="text-xs text-ink-muted">{t('cal.repeat')}</span>
        <Select
          value={frequency ?? 'none'}
          onChange={(e) =>
            onChange({
              ...value,
              frequency: e.target.value === 'none' ? null : (e.target.value as Frequency),
            })
          }
        >
          <option value="none">{t('cal.repeat.none')}</option>
          <option value="daily">{t('cal.repeat.daily')}</option>
          <option value="weekly">{t('cal.repeat.weekly')}</option>
          <option value="monthly">{t('cal.repeat.monthly')}</option>
          <option value="yearly">{t('cal.repeat.yearly')}</option>
        </Select>
      </label>

      {frequency && (
        <div className="space-y-3 rounded-panel bg-surface-2 p-3">
          <div className="flex items-center gap-2 text-sm">
            <label htmlFor="repeat-interval" className="text-ink-muted">
              {t('cal.repeat.every')}
            </label>
            <input
              id="repeat-interval"
              className={`${inputClass} w-20`}
              type="number"
              min={1}
              inputMode="numeric"
              value={Number.isNaN(value.interval) ? '' : value.interval}
              onChange={(e) => onChange({ ...value, interval: e.target.valueAsNumber })}
            />
            <span>{t(UNITS[frequency][value.interval === 1 ? 0 : 1])}</span>
          </div>

          {frequency === 'weekly' && (
            <div className="space-y-1">
              <span className="text-xs text-ink-muted">{t('cal.repeat.on')}</span>
              <div className="flex flex-wrap gap-1.5">
                {DAY_CODES.map((code, i) => (
                  <button
                    key={code}
                    type="button"
                    aria-pressed={value.byDay.includes(code)}
                    onClick={() => toggleDay(code)}
                    className={`min-w-10 rounded-control border px-2 py-1.5 text-sm transition-colors ${
                      value.byDay.includes(code)
                        ? 'border-accent bg-accent text-accent-ink'
                        : 'border-line text-ink-muted hover:bg-canvas hover:text-ink'
                    }`}
                  >
                    {DAY_LABELS[i]}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <label className="space-y-1">
              <span className="text-xs text-ink-muted">{t('cal.repeat.ends')}</span>
              <Select
                value={value.end}
                onChange={(e) => onChange({ ...value, end: e.target.value as RepeatEnd })}
              >
                {ENDS.map(([end, label]) => (
                  <option key={end} value={end}>
                    {t(label)}
                  </option>
                ))}
              </Select>
            </label>
            {value.end === 'count' && (
              <label className="space-y-1">
                <span className="text-xs text-ink-muted">{t('cal.repeat.times')}</span>
                <input
                  className={inputClass}
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={Number.isNaN(value.count) ? '' : value.count}
                  onChange={(e) => onChange({ ...value, count: e.target.valueAsNumber })}
                />
              </label>
            )}
            {value.end === 'until' && (
              <label className="space-y-1">
                <span className="text-xs text-ink-muted">{t('cal.repeat.end.until')}</span>
                <input
                  className={inputClass}
                  type="date"
                  value={value.until}
                  onChange={(e) => onChange({ ...value, until: e.target.value })}
                />
              </label>
            )}
          </div>

          {error && <p className="text-xs text-danger">{t(`cal.repeat.error.${error}`)}</p>}
        </div>
      )}
    </div>
  )
}
