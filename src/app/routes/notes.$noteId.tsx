import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useAccounts } from '../../features/mail/hooks'
import { NoteEditor } from '../../features/notes/NoteEditor'
import { useNote } from '../../features/notes/hooks'
import { t } from '../../lib/i18n'
import { EmptyState } from '../../ui/EmptyState'

export const Route = createFileRoute('/notes/$noteId')({
  component: NoteDetail,
})

function NoteDetail() {
  const { noteId } = useParams({ from: '/notes/$noteId' })
  const account = useAccounts()?.[0]
  const note = useNote(account?.id, noteId)
  const navigate = useNavigate()

  if (!account) return null
  // Undefined while the query is still running, and also for a note that is
  // gone; the empty state is the honest answer to the second and a blink at
  // worst for the first.
  if (!note) return <EmptyState icon="draft" title={t('notes.gone')} />

  return (
    <NoteEditor
      accountId={account.id}
      note={note}
      onDeleted={() => void navigate({ to: '/notes', replace: true })}
      onBack={() => void navigate({ to: '/notes', replace: true })}
    />
  )
}
