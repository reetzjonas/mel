import { createFileRoute, useParams } from '@tanstack/react-router'
import { FileBrowser } from '../../features/files/FileBrowser'
import { useAccounts } from '../../features/mail/hooks'

export const Route = createFileRoute('/files/$folderId')({
  component: FilesFolder,
})

function FilesFolder() {
  const account = useAccounts()?.[0]
  const { folderId } = useParams({ from: '/files/$folderId' })
  if (!account) return null
  // Keyed on the folder so opening a subfolder starts with a clean selection
  // and drop state instead of carrying the previous folder's over.
  return <FileBrowser key={folderId} accountId={account.id} folderId={folderId} />
}
