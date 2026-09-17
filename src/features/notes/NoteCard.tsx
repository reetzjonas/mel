import { Link } from '@tanstack/react-router'
import type { Note } from '../../domain/note'
import { currentLocale, t } from '../../lib/i18n'
import { Icon } from '../../ui/Icon'

const dayFmt = new Intl.DateTimeFormat(currentLocale, { day: 'numeric', month: 'short' })

/** When it last changed, or nothing at all for a note still on its way out. */
function changed(note: Note): string {
  if (!note.modified) return ''
  const at = new Date(note.modified)
  return Number.isNaN(at.getTime()) ? '' : dayFmt.format(at)
}

/**
 * One note in the list: what it is called, and when it last changed.
 *
 * Deliberately no preview of the text and no checkboxes out here. Both were
 * tried and both were wrong: the excerpt says less than the title while taking
 * three times the room, and a list of ticky boxes turns the overview into a
 * second, worse editor. Everything a note *is* happens in the note.
 */
export function NoteCard({ note, selected }: { note: Note; selected: boolean }) {
  return (
    <Link
      to="/notes/$noteId"
      params={{ noteId: note.id }}
      data-selected={selected || undefined}
      aria-label={note.title || t('notes.untitled')}
      className="flex items-center gap-2 rounded-control px-2.5 py-2 transition-colors hover:bg-surface-2 data-selected:bg-accent-wash"
    >
      {note.pinned && <Icon name="flag" size={12} className="shrink-0 text-accent" />}
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
        {note.title || t('notes.untitled')}
      </span>
      {note.due && (
        <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-muted">
          {note.due}
        </span>
      )}
      <span className="shrink-0 text-[11px] text-ink-subtle tabular-nums">{changed(note)}</span>
    </Link>
  )
}
