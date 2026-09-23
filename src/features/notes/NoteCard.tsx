import { Link } from '@tanstack/react-router'
import type { Note } from '../../domain/note'
import { currentLocale, t } from '../../lib/i18n'
import { Icon } from '../../ui/Icon'
import { isOverdue } from './noteList'

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
 * Deliberately no preview of the text and no *inline markdown checklist*
 * rendering out here. Both were tried and both were wrong: the excerpt says
 * less than the title while taking three times the room, and drawing a
 * note's own checkbox items in the list turns the overview into a second,
 * worse editor. Everything a note *is* happens in the note. The checkbox
 * this row does carry, over the pin flag, is unrelated — it selects the
 * *row* for a bulk action, the way Files' and Contacts' rows do.
 */
export function NoteCard({
  note,
  selected,
  checked,
  selecting,
  onToggle,
}: {
  note: Note
  selected: boolean
  checked: boolean
  /** Checkbox pinned visible — turned on explicitly, or once anything is checked. */
  selecting: boolean
  onToggle: (extend: boolean) => void
}) {
  return (
    <Link
      to="/notes/$noteId"
      params={{ noteId: note.id }}
      data-selected={selected || undefined}
      data-checked={checked || undefined}
      aria-label={note.title || t('notes.untitled')}
      onClick={(e) => {
        if (!selecting) return
        e.preventDefault()
        onToggle(e.shiftKey)
      }}
      className="flex items-center gap-2 rounded-control px-2.5 py-2 transition-colors hover:bg-surface-2 data-checked:bg-accent-wash data-selected:bg-accent-wash"
    >
      {/* The pin flag doubles as the checkbox, the way Files' node icon does —
          reacting only when the pointer is on it, so hovering the row doesn't
          blank the flag out. Reserved even for an unpinned note so the title
          doesn't shift as the checkbox comes and goes. On a phone the button
          is a full 44px target that reaches out over the row's padding, with
          the 17px box drawn inside it. */}
      <span className="relative -my-2 -ml-2 flex size-11 shrink-0 items-center justify-center sm:m-0 sm:size-[17px]">
        <Icon
          name="flag"
          size={12}
          className={`text-accent ${checked || !note.pinned ? 'invisible' : ''}`}
        />
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={`${t('notes.selectToggle')} ${note.title || t('notes.untitled')}`}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onToggle(e.shiftKey)
          }}
          className="group absolute inset-0 flex items-center justify-center"
        >
          <span
            className={`flex size-[17px] items-center justify-center rounded-[4px] transition-opacity ${
              checked
                ? 'bg-accent text-accent-ink'
                : `bg-surface-2 text-ink-muted ring-1 ring-line ring-inset ${
                    selecting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`
            }`}
          >
            <Icon name="check" size={12} />
          </span>
        </button>
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
        {note.title || t('notes.untitled')}
      </span>
      {note.due && (
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${
            isOverdue(note) ? 'bg-danger-wash text-danger' : 'bg-surface-2 text-ink-muted'
          }`}
        >
          {note.due}
        </span>
      )}
      <span className="shrink-0 text-[11px] text-ink-subtle tabular-nums">{changed(note)}</span>
    </Link>
  )
}
