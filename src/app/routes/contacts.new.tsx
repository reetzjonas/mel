import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { emptyContact } from '../../domain/contact'
import { ContactEditor } from '../../features/contacts/ContactEditor'
import { useDefaultAddressBookId } from '../../features/contacts/hooks'
import { useAccounts } from '../../features/mail/hooks'
import { createContact } from '../../services/contacts'

export const Route = createFileRoute('/contacts/new')({
  component: NewContact,
})

function NewContact() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const bookId = useDefaultAddressBookId(account?.id)
  const navigate = useNavigate()

  if (!account || !bookId) return null
  return (
    <ContactEditor
      initial={emptyContact(bookId)}
      onCancel={() => void navigate({ to: '/contacts' })}
      onSave={(c) => {
        const cleaned = { ...c, emails: c.emails.filter((e) => e.value.trim()) }
        void createContact(account.id, cleaned).then((id) =>
          navigate({ to: '/contacts/$contactId', params: { contactId: id } }),
        )
      }}
    />
  )
}
