import type { Key } from 'openpgp'
import { parseAutocrypt } from '../domain/autocrypt'
import { emptyContact, storedContact, type Contact } from '../domain/contact'
import { keyFromText, keyKind, keyText, type ContactKey } from '../domain/contactKey'
import type { EmailAddress } from '../domain/email'
import type { KeyInfo } from '../domain/pgp'
import { db, type ContactRow } from '../storage/db'
import { openEnvelope } from '../storage/envelope'
import { createContact, updateContact } from './contacts'
import { describeKey, loadOpenpgp, ownKeys } from './pgpKeys'

/*
 * Autocrypt (issue #101): the user's public key goes out in a header of every
 * message, and a correspondent's key can be picked up from theirs. Header
 * only — gossip and the setup message are out of scope.
 */

const norm = (email: string) => email.trim().toLowerCase()

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/**
 * The smallest form of a key that is still usable for this address, as the
 * spec asks: the primary key, the one user id naming the address, and the
 * encryption subkey, each with its self-signatures. Photos, other user ids,
 * signing subkeys and third-party certifications stay behind — they would
 * put a few kilobytes more into every message.
 */
async function minimalKey(key: Key, addr: string): Promise<Uint8Array | null> {
  const openpgp = await loadOpenpgp()
  const copy = await openpgp.readKey({ binaryKey: key.toPublic().write() })
  const user = copy.users.find((u) => u.userID && norm(u.userID.email) === addr)
  if (!user) return null
  let encryption
  try {
    encryption = await copy.getEncryptionKey(undefined, undefined, { email: addr })
  } catch {
    return null // expired, revoked, or no key that can encrypt
  }
  user.otherCertifications = []
  copy.users = [user]
  const id = encryption.getKeyID()
  copy.subkeys = copy.subkeys.filter((s) => s.getKeyID().equals(id))
  return copy.write()
}

const minimal = new Map<string, Promise<string | null>>()

/**
 * The `keydata` for mail from `email`, or null when the user has no key for
 * that address that could be encrypted to. Needs no unlocking: the public
 * half of a stored secret key is readable as it is.
 */
export async function ownAutocryptKeydata(
  accountId: string,
  email: string,
): Promise<string | null> {
  const addr = norm(email)
  const keys = await ownKeys(accountId)
  if (!keys.length || !addr) return null
  const cacheKey = `${accountId}\n${addr}\n${keys.map((k) => k.fingerprint).join(',')}`
  let found = minimal.get(cacheKey)
  if (!found) {
    found = (async () => {
      const openpgp = await loadOpenpgp()
      for (const own of keys) {
        try {
          const key = await openpgp.readPrivateKey({ armoredKey: own.armored })
          const bytes = await minimalKey(key, addr)
          if (bytes) return base64(bytes)
        } catch {
          // A stored key that no longer reads offers nothing to send.
        }
      }
      return null
    })()
    minimal.set(cacheKey, found)
  }
  return found
}

/** What the reading pane offers about a key found in a message. */
export type AutocryptOffer =
  /** The sender has no key in the contacts yet: offer to save this one. */
  | {
      kind: 'add'
      sender: EmailAddress
      info: KeyInfo
      key: ContactKey
      /** The contact to add it to; null means a new contact is made for the sender. */
      contactId: string | null
    }
  /**
   * The contacts hold a different key for the sender. Said as a warning and
   * never acted on: it may be a new key, or someone who is not the sender.
   */
  | { kind: 'differs'; sender: EmailAddress; info: KeyInfo }

function contactsWith(rows: ContactRow[], addr: string): Contact[] {
  return rows
    .map((r) => storedContact(openEnvelope(r.payload)))
    .filter((c) => c.emails.some((e) => norm(e.value) === addr))
}

/**
 * Whether the message's Autocrypt header has anything worth saying.
 *
 * Null when there is no usable key in it, or when the contacts already hold
 * that very key. Comparing by fingerprint: a key that comes back with a new
 * expiry date is still the key the user already has.
 */
export async function autocryptOffer(
  accountId: string,
  values: string[] | null | undefined,
  sender: EmailAddress,
): Promise<AutocryptOffer | null> {
  const header = parseAutocrypt(values, sender.email)
  if (!header) return null
  const openpgp = await loadOpenpgp()
  let key: Key
  try {
    key = await openpgp.readKey({
      binaryKey: Uint8Array.from(atob(header.keydata), (c) => c.charCodeAt(0)),
    })
    await key.getEncryptionKey()
  } catch {
    return null
  }
  const armored = key.armor()
  const info = await describeKey(armored)
  const contactKey = keyFromText(armored)
  if (!info || !contactKey) return null

  const rows = await db.contacts.where('accountId').equals(accountId).toArray()
  const cards = contactsWith(rows, header.addr)
  const stored: string[] = []
  for (const card of cards) {
    for (const k of card.cryptoKeys) {
      const text = keyKind(k) === 'pgp' ? keyText(k) : null
      if (!text) continue
      try {
        for (const s of await openpgp.readKeys({ armoredKeys: text }))
          stored.push(s.getFingerprint())
      } catch {
        // A damaged key on the card is no key to compare against.
      }
    }
  }
  if (stored.includes(info.fingerprint)) return null
  const who = { name: sender.name, email: header.addr }
  if (stored.length) return { kind: 'differs', sender: who, info }
  return { kind: 'add', sender: who, info, key: contactKey, contactId: cards[0]?.id ?? null }
}

/** Save the offered key: onto the sender's card, or onto a new one for them. */
export async function saveAutocryptKey(
  accountId: string,
  offer: Extract<AutocryptOffer, { kind: 'add' }>,
): Promise<void> {
  if (offer.contactId) {
    const row = await db.contacts.get([accountId, offer.contactId])
    if (!row) throw new Error('contact gone')
    const contact = storedContact(openEnvelope(row.payload))
    await updateContact(accountId, { ...contact, cryptoKeys: [...contact.cryptoKeys, offer.key] })
    return
  }
  const books = (await db.addressBooks.where('accountId').equals(accountId).toArray()).map((r) =>
    openEnvelope(r.payload),
  )
  const book = books.find((b) => b.isDefault) ?? books[0]
  if (!book) throw new Error('no address book')
  const { id: _id, ...blank } = emptyContact(book.id)
  await createContact(accountId, {
    ...blank,
    fullName: offer.sender.name?.trim() ?? '',
    emails: [{ value: offer.sender.email, label: null }],
    cryptoKeys: [offer.key],
  })
}
