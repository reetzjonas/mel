import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Note } from '../../domain/note'
import { t } from '../../lib/i18n'
import { imageNames, imageRef } from '../../lib/noteFile'
import { deleteNote, saveNote, stageNoteImage } from '../../services/notes'
import { Icon } from '../../ui/Icon'
import { inputClass, secondaryButtonClass } from '../../ui/styles'
import { useNoteImages } from './hooks'

/*
 * Behind a boundary of its own: CodeMirror and its Markdown grammar are the
 * heaviest thing mel ships, and they are worth nothing to anyone who never
 * opens a note. Everything under this import is fetched when one is opened.
 */
const MarkdownEditor = lazy(() => import('./MarkdownEditor'))

/** How long the editor waits after the last keystroke before it writes. */
const AUTOSAVE_MS = 800

/**
 * The note itself, written and read in the same place.
 *
 * The text stays Markdown — it is the file, after all — and the formatting is
 * drawn over it: a heading looks like a heading, `- [ ]` is a checkbox that
 * ticks, a picture hangs under the line that refers to it, and the markup
 * comes back on whichever line the cursor is in. See `liveMarkdown.ts`.
 */
export function NoteEditor({
  accountId,
  note,
  onDeleted,
}: {
  accountId: string
  note: Note
  onDeleted: () => void
}) {
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const [saved, setSaved] = useState<{ id: string; title: string; body: string }>({
    id: note.id,
    title: note.title,
    body: note.body,
  })
  const picker = useRef<HTMLInputElement>(null)

  /*
   * The note as the store has it, beside what is being typed. Switching notes
   * — or this one coming back changed from the server — replaces the text in
   * the boxes; a keystroke in between must not be overwritten by the save it
   * triggered, which is what comparing against the last saved value is for.
   */
  if (saved.id !== note.id) {
    setSaved({ id: note.id, title: note.title, body: note.body })
    setTitle(note.title)
    setBody(note.body)
  }

  const dirty = title !== saved.title || body !== saved.body

  useEffect(() => {
    if (!dirty) return
    const timer = setTimeout(() => {
      setSaved({ id: note.id, title, body })
      void saveNote(accountId, { ...note, title, body })
    }, AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [accountId, note, title, body, dirty])

  /** Write now rather than in a moment — for the toggles, where there is no typing to wait for. */
  const write = (changes: Partial<Note>) => {
    const next = { ...note, title, body, ...changes }
    setSaved({ id: next.id, title: next.title, body: next.body })
    setTitle(next.title)
    setBody(next.body)
    void saveNote(accountId, next)
  }

  const addImage = async (file: File | undefined) => {
    if (!file) return
    const name = await stageNoteImage(accountId, note.id, file, imageNames(body))
    // Appended rather than inserted at the cursor: an image belongs to the note
    // as a whole, and a caret position is not worth guessing at.
    write({ body: `${body.replace(/\s+$/, '')}\n\n${imageRef(name)}\n` })
  }

  const imageUrls = useNoteImages(accountId, note, imageNames(body))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <input
          /* No focus ring on either box: both fill their half of the pane, so
             a ring is a line around the whole panel, and the caret already
             says where the writing goes — the same call compose makes for the
             message body (.ProseMirror in index.css). */
          className="min-w-0 flex-1 bg-transparent text-[15px] font-medium text-ink outline-none focus-visible:outline-none placeholder:text-ink-subtle"
          placeholder={t('notes.titlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label={t('notes.title')}
        />
        <button
          type="button"
          aria-label={t('notes.pin')}
          aria-pressed={note.pinned}
          onClick={() => write({ pinned: !note.pinned })}
          className={`rounded-control p-1.5 transition-colors hover:bg-surface-2 ${
            note.pinned ? 'text-accent' : 'text-ink-muted'
          }`}
        >
          <Icon name="flag" size={15} />
        </button>
        <button
          type="button"
          aria-label={t('notes.checklist')}
          onClick={() => {
            // A list starts where the writing is: an empty note gets its first
            // item, one with text gets another line under it.
            setBody(`${body.replace(/\s+$/, '')}${body.trim() ? '\n' : ''}- [ ] `)
          }}
          className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="check" size={15} />
        </button>
        <button
          type="button"
          aria-label={t('notes.addImage')}
          onClick={() => picker.current?.click()}
          className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="paperclip" size={15} />
        </button>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void addImage(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>

      <Suspense fallback={<div className="min-h-0 flex-1" />}>
        <MarkdownEditor
          value={body}
          images={imageUrls}
          placeholder={t('notes.bodyPlaceholder')}
          ariaLabel={t('notes.body')}
          onChange={setBody}
        />
      </Suspense>

      <div className="flex items-center gap-2 border-t border-line p-3">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          {t('notes.due')}
          <input
            type="date"
            className={`${inputClass} !w-auto !py-1`}
            value={note.due ?? ''}
            onChange={(e) => write({ due: e.target.value || null })}
            aria-label={t('notes.due')}
          />
        </label>
        <span className="text-xs text-ink-subtle">{dirty ? t('notes.saving') : ''}</span>
        <button
          type="button"
          onClick={() => {
            if (!window.confirm(t('notes.delete.confirm'))) return
            void deleteNote(accountId, note).then(onDeleted)
          }}
          className={`ml-auto ${secondaryButtonClass} !text-danger`}
        >
          {t('notes.delete')}
        </button>
      </div>
    </div>
  )
}
