import type { Note } from '../../domain/note'

export type DueFilter = 'all' | 'overdue' | 'today' | 'upcoming' | 'none'
export type NoteSort = 'recent' | 'due'

/** A plain local calendar date, safe to compare with a note's `YYYY-MM-DD` due date. */
export function todayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function isOverdue(note: Note, today = todayKey()): boolean {
  return Boolean(note.due && note.due < today)
}

export function matchesDueFilter(note: Note, filter: DueFilter, today = todayKey()): boolean {
  if (filter === 'all') return true
  if (filter === 'none') return note.due === null
  if (filter === 'overdue') return isOverdue(note, today)
  if (filter === 'today') return note.due === today
  return Boolean(note.due && note.due > today)
}

function recentOrder(a: Note, b: Note): number {
  const at = a.modified || '9999'
  const bt = b.modified || '9999'
  return bt.localeCompare(at)
}

/**
 * Pinned notes stay together at the top. In due order, dated notes rise above
 * undated ones and earliest dates come first; recency makes equal dates stable.
 */
export function sortNotes(notes: Note[], sort: NoteSort): Note[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (sort === 'recent') return recentOrder(a, b)
    if (a.due !== b.due) {
      if (a.due === null) return 1
      if (b.due === null) return -1
      return a.due.localeCompare(b.due)
    }
    return recentOrder(a, b)
  })
}
