import { useActiveAccount } from '../../lib/activeAccount'
import { Outlet, createFileRoute } from '@tanstack/react-router'
import { CapabilityNotice } from '../../features/settings/ServerCapabilities'
import { useAccounts } from '../../features/mail/hooks'

export const Route = createFileRoute('/files')({
  validateSearch: (search: Record<string, unknown>): { preview?: string } => ({
    preview:
      typeof search['preview'] === 'string' && search['preview'] ? search['preview'] : undefined,
  }),
  component: FilesLayout,
})

function FilesLayout() {
  const accounts = useAccounts()
  const account = useActiveAccount(accounts)
  if (accounts === undefined) return null
  if (!account?.capabilities.files) return <CapabilityNotice reason="caps.unsupported.files" />
  return <Outlet />
}
