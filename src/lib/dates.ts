import { isThisYear, isToday } from 'date-fns'
import { currentLocale } from './i18n'

const time = new Intl.DateTimeFormat(currentLocale, { hour: 'numeric', minute: '2-digit' })
const dayMonth = new Intl.DateTimeFormat(currentLocale, { day: 'numeric', month: 'short' })
const shortDate = new Intl.DateTimeFormat(currentLocale, { dateStyle: 'medium' })
const fullDate = new Intl.DateTimeFormat(currentLocale, {
  dateStyle: 'full',
  timeStyle: 'short',
})

export function formatListDate(value: number | string): string {
  const d = new Date(value)
  if (isToday(d)) return time.format(d)
  if (isThisYear(d)) return dayMonth.format(d)
  return shortDate.format(d)
}

export function formatFullDate(iso: string): string {
  return fullDate.format(new Date(iso))
}
