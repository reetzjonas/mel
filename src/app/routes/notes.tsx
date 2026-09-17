import { Outlet, createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useAccounts } from '../../features/mail/hooks'
import { NoteCard } from '../../features/notes/NoteCard'
import { useNotes } from '../../features/notes/hooks'
import { CapabilityNotice } from '../../features/settings/ServerCapabilities'
import { t } from '../../lib/i18n'
import { emptyNote, saveNote } from '../../services/notes'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { Tooltip } from '../../ui/Tooltip'

export const Route = createFileRoute('/notes')({
  component: NotesLayout,
})

/**
 * Notes ride on file storage, so they answer to the same capability the Files
 * tab does: no FileNode, nowhere to keep a note.
 */
function NotesLayout() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const notes = useNotes(account?.id)
  const params = useParams({ strict: false }) as { noteId?: string }
  const navigate = useNavigate()

  if (accounts === undefined) return null
  if (!account?.capabilities.files) return <CapabilityNotice reason="caps.unsupported.files" />

  const create = async () => {
    const note = await saveNote(account.id, emptyNote())
    await navigate({ to: '/notes/$noteId', params: { noteId: note.id } })
  }

  const inDetail = Boolean(params.noteId)

  return (
    <div className="flex h-full gap-0 bg-canvas sm:gap-3 sm:p-3">
      <section
        className={`panel flex h-full w-full min-w-0 flex-col overflow-hidden max-sm:rounded-none max-sm:shadow-none lg:flex lg:w-80 lg:shrink-0 ${inDetail ? 'hidden lg:flex' : ''}`}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <h1 className="flex-1 text-[13px] font-semibold">{t('app.notes')}</h1>
          <Tooltip label={t('notes.new')}>
            <button
              type="button"
              aria-label={t('notes.new')}
              onClick={() => void create()}
              className="rounded-control bg-accent p-2 text-accent-ink shadow-raised transition-[background-color,transform] duration-150 hover:bg-accent-hover active:scale-95"
            >
              <Icon name="compose" size={15} />
            </button>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {notes === undefined ? null : notes.length === 0 ? (
            <EmptyState icon="draft" title={t('notes.empty')} hint={t('notes.emptyHint')} />
          ) : (
            notes.map((note) => (
              <NoteCard key={note.id} note={note} selected={note.id === params.noteId} />
            ))
          )}
        </div>
      </section>
      <div className={`h-full min-w-0 flex-1 lg:block ${inDetail ? '' : 'hidden'}`}>
        <div className="panel h-full overflow-hidden max-sm:rounded-none max-sm:shadow-none">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
