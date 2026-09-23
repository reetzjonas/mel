import type { Key, PrivateKey } from 'openpgp'
import type { OutgoingEmail } from '../domain/identity'
import {
  bodyEntity,
  encryptedEntity,
  message,
  signedEntity,
  type MimeAttachment,
} from '../lib/mimeBuild'
import { contactKeysFor, loadOpenpgp, ownKeys, unlockedKeys } from './pgpKeys'

/*
 * Writing OpenPGP mail (issue #63, part 3). Everything cryptographic is
 * OpenPGP.js; lib/mimeBuild.ts only lays out the parts around what it
 * returns.
 */

export interface SecureOptions {
  encrypt: boolean
  sign: boolean
}

/** Why a message cannot go out the way it was asked to. */
export type SecureProblem =
  /** No key of the user's is stored: nothing to sign with, nothing to read the Sent copy with. */
  | { kind: 'noOwnKey' }
  /** Signing needs the key unlocked. */
  | { kind: 'locked' }
  /** These recipients have no usable key on their contact card. */
  | { kind: 'missingKeys'; addresses: string[] }

export class SecureSendError extends Error {
  readonly problem: SecureProblem
  constructor(problem: SecureProblem) {
    super(problem.kind)
    this.problem = problem
  }
}

const norm = (email: string) => email.trim().toLowerCase()

/** Keys on the contact card that can actually be encrypted to: not expired, not revoked. */
async function encryptableKeys(accountId: string, address: string): Promise<Key[]> {
  const keys = await contactKeysFor(accountId, address)
  const usable = await Promise.all(
    keys.map((k) =>
      k.getEncryptionKey().then(
        () => true,
        () => false,
      ),
    ),
  )
  return keys.filter((_, i) => usable[i])
}

/**
 * For each address, whether it can be encrypted to. What compose shows next
 * to the Encrypt switch, so the reason it cannot be turned on is named per
 * person rather than discovered at Send.
 */
export async function recipientsWithoutKey(
  accountId: string,
  addresses: string[],
): Promise<string[]> {
  const unique = [...new Set(addresses.map(norm).filter(Boolean))]
  const found = await Promise.all(unique.map((a) => encryptableKeys(accountId, a)))
  return unique.filter((_, i) => found[i]!.length === 0)
}

/** The user's key for this address: one naming it, or else the only one there is. */
function pick<T extends { getUserIDs(): string[] }>(keys: T[], email: string): T | undefined {
  const mine = norm(email)
  return (
    keys.find((k) =>
      k.getUserIDs().some((id) => id.toLowerCase().includes(`<${mine}>`) || norm(id) === mine),
    ) ?? keys[0]
  )
}

async function ownPublic(accountId: string, email: string): Promise<Key | undefined> {
  const openpgp = await loadOpenpgp()
  const keys: Key[] = []
  for (const own of await ownKeys(accountId)) {
    try {
      keys.push((await openpgp.readPrivateKey({ armoredKey: own.armored })).toPublic())
    } catch {
      // A stored key that no longer reads is no key.
    }
  }
  return pick(keys, email)
}

/** What micalg names the hash a signature was made with (RFC 3156 §5). */
async function micalg(armoredSignature: string): Promise<string> {
  const openpgp = await loadOpenpgp()
  const sig = await openpgp.readSignature({ armoredSignature })
  const id = sig.packets[0]?.hashAlgorithm
  const name = Object.entries(openpgp.enums.hash).find(([, v]) => v === id)?.[0] ?? 'sha256'
  return `pgp-${name.toLowerCase()}`
}

/**
 * The finished message, as raw RFC 5322 text ready to import.
 *
 * Encrypted: one OpenPGP message that is signed (when asked) and encrypted to
 * every recipient and to the user, so the copy in Sent stays readable to them
 * — the form most clients write and every one reads. Signed only: RFC 3156
 * `multipart/signed` over the exact body entity.
 *
 * Every recipient — Bcc included — has to have a key before anything is
 * encrypted. Sending the others an encrypted copy and the rest nothing would
 * be worse than refusing, and sending the rest plaintext would defeat the
 * point.
 */
export async function buildSecureMessage(
  accountId: string,
  mail: OutgoingEmail,
  files: MimeAttachment[],
  options: SecureOptions,
  now = new Date(),
): Promise<string> {
  if (!options.encrypt && !options.sign) throw new Error('nothing to sign or encrypt')
  const openpgp = await loadOpenpgp()
  if (!(await ownKeys(accountId)).length) throw new SecureSendError({ kind: 'noOwnKey' })
  let signingKey: PrivateKey | undefined
  if (options.sign) {
    signingKey = pick(unlockedKeys(accountId), mail.from.email)
    if (!signingKey) throw new SecureSendError({ kind: 'locked' })
  }

  const entity = bodyEntity({ text: mail.text, html: mail.html || null, attachments: files })
  let body: string
  if (options.encrypt) {
    const recipients = [...mail.to, ...mail.cc, ...mail.bcc].map((a) => a.email)
    const missing: string[] = []
    const encryptionKeys: Key[] = []
    for (const address of [...new Set(recipients.map(norm))]) {
      const keys = await encryptableKeys(accountId, address)
      if (keys.length) encryptionKeys.push(...keys)
      else missing.push(address)
    }
    if (missing.length) throw new SecureSendError({ kind: 'missingKeys', addresses: missing })
    const self = await ownPublic(accountId, mail.from.email)
    if (self) encryptionKeys.push(self)
    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({ binary: new TextEncoder().encode(entity) }),
      encryptionKeys,
      ...(signingKey ? { signingKeys: signingKey } : {}),
    })
    body = encryptedEntity(armored)
  } else {
    const signature = await openpgp.sign({
      message: await openpgp.createMessage({ binary: new TextEncoder().encode(entity) }),
      signingKeys: signingKey!,
      detached: true,
    })
    body = signedEntity(entity, signature, await micalg(signature))
  }

  const domain = mail.from.email.split('@')[1] || 'localhost'
  return message(
    {
      from: mail.from,
      to: mail.to,
      cc: mail.cc,
      subject: mail.subject,
      date: now,
      messageId: `${crypto.randomUUID()}@${domain}`,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
    },
    body,
  )
}
