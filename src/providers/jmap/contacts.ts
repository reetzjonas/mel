import type { AddressBook, Contact } from '../../domain/contact'
import { type ContactsProvider, type SetFailure } from '../types'
import { Batch } from './client/request'
import type { Transport } from './client/transport'
import { Cap, type SetError, type SetResponse } from './client/types/core'
import { syncCollection } from './collectionSync'
import {
  fromContact,
  toAddressBook,
  toContact,
  type JmapAddressBook,
  type JmapContactCard,
} from './mappers/contacts'

const USING = [Cap.core, Cap.contacts]

const PERMANENT = new Set(['invalidProperties', 'invalidPatch', 'notFound', 'forbidden', 'overQuota'])

function toFailure(e: SetError | undefined): SetFailure {
  return {
    type: e?.type ?? 'serverFail',
    description: e?.description,
    permanent: e ? PERMANENT.has(e.type) : false,
  }
}

export function createJmapContacts(transport: Transport, accountId: string): ContactsProvider {
  const batch = () => new Batch(transport, USING)

  return {
    syncAddressBooks(sinceState) {
      return syncCollection<JmapAddressBook, AddressBook>(
        batch,
        { type: 'AddressBook', accountId, map: toAddressBook },
        sinceState,
      )
    },
    syncContacts(sinceState) {
      return syncCollection<JmapContactCard, Contact>(
        batch,
        { type: 'ContactCard', accountId, map: toContact },
        sinceState,
      )
    },

    async createContact(contact: Contact): Promise<{ id: string | null; failure: SetFailure | null }> {
      const b = batch()
      const s = b.call<SetResponse<{ id: string }>>('ContactCard/set', {
        accountId,
        create: { c0: fromContact(contact) },
      })
      await b.send()
      const created = s.result.created?.['c0']
      if (created) return { id: created.id, failure: null }
      return { id: null, failure: toFailure(s.result.notCreated?.['c0']) }
    },

    async updateContact(contact: Contact): Promise<SetFailure | null> {
      const b = batch()
      const s = b.call<SetResponse<unknown>>('ContactCard/set', {
        accountId,
        update: { [contact.id]: fromContact(contact) },
      })
      await b.send()
      const err = s.result.notUpdated?.[contact.id]
      return err ? toFailure(err) : null
    },

    async destroyContacts(ids: string[]): Promise<SetFailure | null> {
      const b = batch()
      const s = b.call<SetResponse<unknown>>('ContactCard/set', { accountId, destroy: ids })
      await b.send()
      const errs = Object.values(s.result.notDestroyed ?? {})
      return errs.length ? toFailure(errs[0]) : null
    },
  }
}
