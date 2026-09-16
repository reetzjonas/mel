import { describe, expect, it } from 'vitest'
import { birthdayMonthDay, birthdayYear } from '../../domain/contact'
import { birthdayLabel } from './birthday'

describe('reading a stored birthday', () => {
  it('takes the day and month from a full date', () => {
    expect(birthdayMonthDay('1985-04-20')).toEqual({ month: 4, day: 20 })
    expect(birthdayYear('1985-04-20')).toBe(1985)
  })

  // Plenty of cards record the day and nothing more, and a made-up year would
  // come back as somebody's age.
  it('takes them from a date with no year, and reports no year', () => {
    expect(birthdayMonthDay('--04-20')).toEqual({ month: 4, day: 20 })
    expect(birthdayYear('--04-20')).toBeNull()
  })

  it('refuses what is not a date', () => {
    expect(birthdayMonthDay('')).toBeNull()
    expect(birthdayMonthDay('April')).toBeNull()
    expect(birthdayMonthDay('1985-13-20')).toBeNull()
    expect(birthdayMonthDay('1985-04-00')).toBeNull()
  })
})

describe('showing a birthday', () => {
  it('names the year when the card has one', () => {
    expect(birthdayLabel('1985-04-20')).toMatch(/1985/)
  })

  it('leaves the year out when the card has none', () => {
    const label = birthdayLabel('--04-20')
    expect(label).not.toBe('')
    expect(label).not.toMatch(/\d{4}/)
  })

  // 29 February has to survive being formatted; a placeholder year that cannot
  // hold it would quietly turn it into 1 March.
  it('keeps a leap day a leap day', () => {
    expect(birthdayLabel('--02-29')).toMatch(/29/)
  })

  it('has nothing to show for a card without one', () => {
    expect(birthdayLabel('')).toBe('')
  })
})
