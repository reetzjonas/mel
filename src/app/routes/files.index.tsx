import { createFileRoute } from '@tanstack/react-router'
import { FileBrowser } from '../../features/files/FileBrowser'
import { useAccounts } from '../../features/mail/hooks'

export const Route = createFileRoute('/files/')({
  component: FilesRoot,
})

function FilesRoot() {
  const account = useAccounts()?.[0]
  if (!account) return null
  return <FileBrowser accountId={account.id} folderId={null} />
}
