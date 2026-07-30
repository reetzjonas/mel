import { createFileRoute } from '@tanstack/react-router'
import { t } from '../../lib/i18n'

export const Route = createFileRoute('/contacts/')({
  component: () => (
    <div className="hidden h-full items-center justify-center text-sm text-ink-muted lg:flex">
      {t('contacts.select')}
    </div>
  ),
})
