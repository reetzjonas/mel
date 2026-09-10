import { beforeEach, describe, expect, it } from 'vitest'
import type { Contact } from '../domain/contact'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { suggestRecipients } from './contacts'

const ACC = 'acc-test'

function contactRow(overrides: Partial<Contact>): { accountId: string; id: string; addressBookIds: string[]; sortKey: string; payload: unknown } {
  const c: Contact = {
    id: overrides.id ?? 'c1',
    addressBookIds: { ab1: true },
    kind: 'individual',
    fullName: '',
    given: '',
    surname: '',
    nickname: '',
    organization: '',
    jobTitle: '',
    emails: [],
    phones: [],
    addresses: [],
    urls: [],
    note: '',
    memberUids: [],
    ...overrides,
  }
  return {
    accountId: ACC,
    id: c.id,
    addressBookIds: Object.keys(c.addressBookIds),
    sortKey: c.fullName,
    payload: sealPlain(c) as never,
  }
}

describe('suggestRecipients', () => {
  beforeEach(async () => {
    await db.contacts.where('accountId').equals(ACC).delete()
  })

  it('matches by name or email, case-insensitively', async () => {
    await db.contacts.put(
      contactRow({
        id: 'c1',
        given: 'Erika',
        surname: 'Testling',
        emails: [{ label: 'work', value: 'erika@example.com' }],
      }) as never,
    )
    expect(await suggestRecipients(ACC, 'erik')).toEqual([
      { name: 'Erika Testling', email: 'erika@example.com' },
    ])
    expect(await suggestRecipients(ACC, 'EXAMPLE.COM')).toHaveLength(1)
    expect(await suggestRecipients(ACC, 'zz')).toEqual([])
  })

  it('drops emails that are not really email addresses', async () => {
    // Regression: a contact synced from Exchange can carry a legacyExchangeDN
    // in its email field instead of an SMTP address
    // (`/o=.../ou=.../cn=Recipients/cn=...`). parseAddresses() already drops
    // anything without an '@' at send time, so surfacing it as a pickable
    // suggestion just let a user select something that silently did nothing.
    await db.contacts.put(
      contactRow({
        id: 'c2',
        given: 'Jonas',
        surname: 'Reetz',
        emails: [
          {
            label: 'work',
            value: '/o=First Organization/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=jonas',
          },
          { label: 'home', value: 'jonas@example.com' },
        ],
      }) as never,
    )
    expect(await suggestRecipients(ACC, 'jonas')).toEqual([
      { name: 'Jonas Reetz', email: 'jonas@example.com' },
    ])
  })
})
