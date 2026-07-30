import type { AddressBook, Contact } from '../../domain/contact'
import {
  CannotCalculateChanges,
  type ContactsProvider,
  type SetFailure,
  type SyncPage,
} from '../types'
import { Batch } from './client/request'
import type { Transport } from './client/transport'
import { Cap, type ChangesResponse, type GetResponse, type SetError, type SetResponse } from './client/types/core'
import {
  fromContact,
  toAddressBook,
  toContact,
  type JmapAddressBook,
  type JmapContactCard,
} from './mappers/contacts'

const USING = [Cap.core, Cap.contacts]
const MAX_CHANGES = 256

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

  async function sync<TJmap, TOut>(
    type: 'AddressBook' | 'ContactCard',
    sinceState: string | undefined,
    map: (v: TJmap) => TOut,
  ): Promise<SyncPage<TOut>> {
    if (!sinceState) {
      const b = batch()
      const g = b.call<GetResponse<TJmap>>(`${type}/get`, { accountId, ids: null })
      await b.send()
      const r = g.result
      return { created: r.list.map(map), updated: [], destroyedIds: [], newState: r.state, hasMore: false }
    }
    const b = batch()
    const ch = b.call<ChangesResponse>(`${type}/changes`, {
      accountId,
      sinceState,
      maxChanges: MAX_CHANGES,
    })
    const created = b.call<GetResponse<TJmap>>(`${type}/get`, {
      accountId,
      '#ids': ch.ref('/created'),
    })
    const updated = b.call<GetResponse<TJmap>>(`${type}/get`, {
      accountId,
      '#ids': ch.ref('/updated'),
    })
    await b.send()
    if (ch.error?.type === 'cannotCalculateChanges') throw new CannotCalculateChanges()
    const changes = ch.result
    return {
      created: created.result.list.map(map),
      updated: updated.result.list.map(map),
      destroyedIds: changes.destroyed,
      newState: changes.newState,
      hasMore: changes.hasMoreChanges,
    }
  }

  return {
    syncAddressBooks(sinceState) {
      return sync<JmapAddressBook, AddressBook>('AddressBook', sinceState, toAddressBook)
    },
    syncContacts(sinceState) {
      return sync<JmapContactCard, Contact>('ContactCard', sinceState, toContact)
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
