import { createFileRoute } from '@tanstack/react-router'
import { t } from '../../lib/i18n'
import { EmptyState } from '../../ui/EmptyState'

export const Route = createFileRoute('/mail/$mailboxId/')({
  component: EmptyPane,
})

function EmptyPane() {
  return (
    <div className="hidden h-full lg:block">
      <EmptyState
        icon="mail"
        title={t('mail.selectMessage')}
        hint={t('mail.selectMessageHint')}
      />
    </div>
  )
}
