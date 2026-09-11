import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * Settings used to be a screen of its own. They are a modal now, but the old
 * address stays valid: bookmarks, the browser's history and anything that
 * still points here land on the dialog instead of a dead route.
 */
export const Route = createFileRoute('/settings')({
  beforeLoad: () => {
    throw redirect({ to: '/mail', search: { settings: 'general' } })
  },
})
