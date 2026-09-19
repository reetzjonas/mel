import { describe, expect, it } from 'vitest'
import { formatCategories, parseCategories } from './categories'

describe('parseCategories', () => {
  it('splits on commas and trims', () => {
    expect(parseCategories(' Work ,Family,  Birthday party ')).toEqual([
      'Work',
      'Family',
      'Birthday party',
    ])
  })

  it('drops blanks', () => {
    expect(parseCategories(',, ,Work,')).toEqual(['Work'])
    expect(parseCategories('')).toEqual([])
  })

  it('treats spellings that differ only in case as one, keeping the first', () => {
    expect(parseCategories('Work, work, WORK, Home')).toEqual(['Work', 'Home'])
  })
})

describe('formatCategories', () => {
  it('joins for the text box', () => {
    expect(formatCategories(['Work', 'Home'])).toBe('Work, Home')
  })

  it('is empty for an event that never read any', () => {
    expect(formatCategories(undefined)).toBe('')
  })

  it('round-trips with parseCategories', () => {
    expect(parseCategories(formatCategories(['A b', 'C']))).toEqual(['A b', 'C'])
  })
})
