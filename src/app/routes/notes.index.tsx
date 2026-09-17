import { createFileRoute } from '@tanstack/react-router'
import { t } from '../../lib/i18n'
import { EmptyState } from '../../ui/EmptyState'

export const Route = createFileRoute('/notes/')({
  component: NoNoteSelected,
})

function NoNoteSelected() {
  return <EmptyState icon="draft" title={t('notes.pick')} />
}
