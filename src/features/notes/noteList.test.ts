import { describe, expect, it } from 'vitest'
import type { Note } from '../../domain/note'
import { isOverdue, matchesDueFilter, sortNotes, todayKey } from './noteList'

function note(id: string, patch: Partial<Note> = {}): Note {
  return {
    id,
    folderId: id,
    fileId: id,
    folderName: id,
    title: id,
    body: '',
    pinned: false,
    due: null,
    linkedTo: null,
    extra: {},
    modified: '2026-09-20T12:00:00Z',
    ...patch,
  }
}

describe('note due list helpers', () => {
  it('uses a local plain date rather than UTC for date comparisons', () => {
    expect(todayKey(new Date(2026, 8, 20, 0, 1))).toBe('2026-09-20')
  })

  it('separates overdue, today, future and undated notes', () => {
    const today = '2026-09-20'
    const overdue = note('overdue', { due: '2026-09-19' })
    const dueToday = note('today', { due: today })
    const upcoming = note('upcoming', { due: '2026-09-21' })
    const none = note('none')

    expect(isOverdue(overdue, today)).toBe(true)
    expect(matchesDueFilter(overdue, 'overdue', today)).toBe(true)
    expect(matchesDueFilter(dueToday, 'today', today)).toBe(true)
    expect(matchesDueFilter(upcoming, 'upcoming', today)).toBe(true)
    expect(matchesDueFilter(none, 'none', today)).toBe(true)
    expect(matchesDueFilter(upcoming, 'overdue', today)).toBe(false)
  })

  it('keeps pinned notes first and sorts due dates before undated notes', () => {
    const notes = [
      note('none', { modified: '2026-09-22T00:00:00Z' }),
      note('late', { due: '2026-09-22' }),
      note('early', { due: '2026-09-21' }),
      note('pinned', { pinned: true, due: '2026-09-30' }),
    ]

    expect(sortNotes(notes, 'due').map((item) => item.id)).toEqual([
      'pinned',
      'early',
      'late',
      'none',
    ])
  })
})
