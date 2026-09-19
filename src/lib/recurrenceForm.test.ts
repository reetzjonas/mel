import { describe, expect, it } from 'vitest'
import type { RecurrenceRule } from '../domain/calendar'
import {
  dayCodeOfDate,
  followStartDay,
  formOf,
  repeatError,
  ruleOf,
  sameForm,
  type RepeatForm,
} from './recurrenceForm'

// 2026-08-03 is a Monday.
const START = '2026-08-03'

const weekly: RepeatForm = { ...formOf(null, START), frequency: 'weekly' }

describe('dayCodeOfDate', () => {
  it('names the weekday, Monday first', () => {
    expect(dayCodeOfDate('2026-08-03')).toBe('mo')
    expect(dayCodeOfDate('2026-08-09')).toBe('su')
    expect(dayCodeOfDate('2026-08-05T10:00:00')).toBe('we')
  })
})

describe('formOf', () => {
  it('starts an event without a rule as "does not repeat", on its own weekday', () => {
    const form = formOf(null, START)
    expect(form.frequency).toBeNull()
    expect(form.interval).toBe(1)
    expect(form.byDay).toEqual(['mo'])
    expect(form.end).toBe('never')
  })

  it('reads interval, weekdays and a count out of a rule', () => {
    const form = formOf({ frequency: 'weekly', interval: 2, byDay: ['fr', 'mo'], count: 6 }, START)
    expect(form).toMatchObject({
      frequency: 'weekly',
      interval: 2,
      byDay: ['mo', 'fr'],
      end: 'count',
      count: 6,
    })
  })

  it('reads an until as a date', () => {
    const form = formOf({ frequency: 'daily', until: '2026-12-24T23:59:59' }, START)
    expect(form.end).toBe('until')
    expect(form.until).toBe('2026-12-24')
  })

  it('ignores an interval that is not positive', () => {
    expect(formOf({ frequency: 'daily', interval: 0 }, START).interval).toBe(1)
  })

  it('takes the start weekday when a weekly rule names none', () => {
    expect(formOf({ frequency: 'weekly' }, START).byDay).toEqual(['mo'])
  })
})

describe('ruleOf', () => {
  it('is null for no repeat', () => {
    expect(ruleOf(formOf(null, START), START, null)).toBeNull()
  })

  it('leaves the interval out when it is 1', () => {
    expect(ruleOf({ ...weekly, byDay: ['mo'] }, START, null)).toEqual({
      frequency: 'weekly',
      byDay: ['mo'],
    })
  })

  it('writes every-2-weeks on several days in week order', () => {
    const rule = ruleOf({ ...weekly, interval: 2, byDay: ['fr', 'mo', 'we'] }, START, null)
    expect(rule).toEqual({ frequency: 'weekly', interval: 2, byDay: ['mo', 'we', 'fr'] })
  })

  it('falls back to the start weekday when no weekday is chosen', () => {
    expect(ruleOf({ ...weekly, byDay: [] }, START, null)?.byDay).toEqual(['mo'])
  })

  it('writes a count, or an until at the end of its day, never both', () => {
    const counted = ruleOf({ ...weekly, end: 'count', count: 10 }, START, null)
    expect(counted?.count).toBe(10)
    expect(counted?.until).toBeUndefined()
    const dated = ruleOf({ ...weekly, end: 'until', until: '2026-12-31' }, START, null)
    expect(dated?.until).toBe('2026-12-31T23:59:59')
    expect(dated?.count).toBeUndefined()
  })

  it("keeps a monthly rule's byMonthDay that has no control here", () => {
    const base: RecurrenceRule = { frequency: 'monthly', byMonthDay: [1, 15] }
    const form = { ...formOf(base, START), interval: 3 }
    expect(ruleOf(form, START, base)).toEqual({
      frequency: 'monthly',
      interval: 3,
      byMonthDay: [1, 15],
    })
  })

  it('drops byMonthDay when the frequency changes', () => {
    const base: RecurrenceRule = { frequency: 'monthly', byMonthDay: [15] }
    const form: RepeatForm = { ...formOf(base, START), frequency: 'yearly' }
    expect(ruleOf(form, START, base)).toEqual({ frequency: 'yearly' })
  })
})

describe('sameForm', () => {
  it('sees an untouched form as unchanged', () => {
    const rule: RecurrenceRule = {
      frequency: 'weekly',
      byDay: ['mo'],
      until: '2026-09-01T10:00:00',
    }
    expect(sameForm(formOf(rule, START), formOf(rule, START))).toBe(true)
  })

  it('sees a changed interval', () => {
    const a = formOf({ frequency: 'daily' }, START)
    expect(sameForm(a, { ...a, interval: 2 })).toBe(false)
  })

  it('ignores a count that the end condition does not use', () => {
    const a = formOf({ frequency: 'daily' }, START)
    expect(sameForm(a, { ...a, count: 99 })).toBe(true)
  })

  it('treats two "no repeat" forms as equal whatever else they hold', () => {
    expect(sameForm(formOf(null, START), { ...formOf(null, START), interval: 5 })).toBe(true)
  })
})

describe('repeatError', () => {
  it('accepts a plain form', () => {
    expect(repeatError(weekly, START)).toBeNull()
  })

  it('needs a positive whole interval', () => {
    expect(repeatError({ ...weekly, interval: 0 }, START)).toBe('interval')
    expect(repeatError({ ...weekly, interval: 1.5 }, START)).toBe('interval')
  })

  it('needs at least one weekday for a weekly rule', () => {
    expect(repeatError({ ...weekly, byDay: [] }, START)).toBe('days')
  })

  it('needs a positive count when it counts', () => {
    expect(repeatError({ ...weekly, end: 'count', count: 0 }, START)).toBe('count')
    expect(repeatError({ ...weekly, count: 0 }, START)).toBeNull()
  })

  it('needs an until that is not before the start', () => {
    expect(repeatError({ ...weekly, end: 'until', until: '2026-08-02' }, START)).toBe('until')
    expect(repeatError({ ...weekly, end: 'until', until: '' }, START)).toBe('until')
    expect(repeatError({ ...weekly, end: 'until', until: START }, START)).toBeNull()
  })

  it('has nothing to say about an event that does not repeat', () => {
    expect(repeatError({ ...formOf(null, START), interval: 0 }, START)).toBeNull()
  })
})

describe('followStartDay', () => {
  it('moves a lone weekday along with the start date', () => {
    expect(followStartDay({ ...weekly, byDay: ['mo'] }, '2026-08-03', '2026-08-05').byDay).toEqual([
      'we',
    ])
  })

  it('leaves a chosen set of weekdays alone', () => {
    const form = { ...weekly, byDay: ['mo', 'fr'] }
    expect(followStartDay(form, '2026-08-03', '2026-08-05')).toBe(form)
  })

  it('leaves a lone weekday that was picked on purpose alone', () => {
    const form = { ...weekly, byDay: ['fr'] }
    expect(followStartDay(form, '2026-08-03', '2026-08-05')).toBe(form)
  })

  it('leaves other frequencies alone', () => {
    const form: RepeatForm = { ...weekly, frequency: 'daily' }
    expect(followStartDay(form, '2026-08-03', '2026-08-05')).toBe(form)
  })
})
