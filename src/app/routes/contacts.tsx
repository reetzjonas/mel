import { createFileRoute } from '@tanstack/react-router'
import { t } from '../../lib/i18n'

export const Route = createFileRoute('/contacts')({
  component: ContactsApp,
})

function ContactsApp() {
  return (
    <div className="flex h-full items-center justify-center text-ink-muted">
      {t('app.comingSoon.contacts')}
    </div>
  )
}
