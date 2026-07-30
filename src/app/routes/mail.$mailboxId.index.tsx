import { createFileRoute } from '@tanstack/react-router'
import { t } from '../../lib/i18n'

export const Route = createFileRoute('/mail/$mailboxId/')({
  component: EmptyPane,
})

function EmptyPane() {
  return (
    <div className="hidden h-full items-center justify-center text-sm text-ink-muted lg:flex">
      {t('mail.selectMessage')}
    </div>
  )
}
