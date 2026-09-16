import { birthdayMonthDay, birthdayYear } from '../../domain/contact'
import { currentLocale } from '../../lib/i18n'

const dayMonth = new Intl.DateTimeFormat(currentLocale, { day: 'numeric', month: 'long' })
const dayMonthYear = new Intl.DateTimeFormat(currentLocale, { dateStyle: 'long' })

/**
 * A birthday as people read it, '' when the card holds nothing usable.
 *
 * Formatted through a date in a fixed year when the card gives none, so the
 * month name still comes out in the reader's language — the year is simply not
 * shown. 2001 is a non-leap year on purpose: 29 February with no year attached
 * has to survive being formatted, and it does so as 1 March if the placeholder
 * year cannot hold it, which would be wrong.
 */
export function birthdayLabel(birthday: string): string {
  const monthDay = birthdayMonthDay(birthday)
  if (!monthDay) return ''
  const year = birthdayYear(birthday)
  const date = new Date(Date.UTC(year ?? 2004, monthDay.month - 1, monthDay.day))
  return year ? dayMonthYear.format(date) : dayMonth.format(date)
}
