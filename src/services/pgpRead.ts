import type { Key, VerifyMessageResult } from 'openpgp'
import type { EmailBody } from '../domain/email'
import {
  encryptedPart,
  inlineBlock,
  isSignedEntity,
  splitSigned,
  type PgpKind,
  type SignatureCheck,
} from '../domain/pgp'
import { connectionFor } from '../sync/connections'
import { contactKeysFor, loadOpenpgp, ownKeys, unlockedKeys } from './pgpKeys'

/*
 * Reading OpenPGP mail (issue #63): decrypting it and checking its signature.
 * Nothing opened here is written anywhere — the plaintext lives in the
 * reading pane's state and is gone when the message is closed.
 */

export interface OpenedAttachment {
  name: string
  type: string
  cid: string | null
  disposition: string | null
  data: Uint8Array
}

/** What was inside an encrypted message, parsed the way the server would have. */
export interface OpenedContent {
  html: string | null
  text: string | null
  attachments: OpenedAttachment[]
}

export type SecureView =
  /** Encrypted, and no key of the user's is stored at all. */
  | { state: 'noKey' }
  /** Encrypted, and the user's key is stored but not unlocked this session. */
  | { state: 'locked' }
  /** Encrypted to someone else's key, or damaged. */
  | { state: 'undecryptable' }
  /** The ciphertext or the raw message could not be fetched (offline, say). */
  | { state: 'unavailable' }
  | {
      state: 'open'
      encrypted: boolean
      signature: SignatureCheck | null
      /** Only part of the text was signed or encrypted; the rest is the sender's say-so. */
      partial: boolean
      /** Replaces the server's reading of the body; null keeps it (signed-only mail). */
      content: OpenedContent | null
    }

export interface SecureInput {
  emailId: string
  body: EmailBody
  kind: PgpKind
  /** The From address, whose contact card the signing key has to come from. */
  sender: string | null
  /** Whether the message is from the user, so their own key may have signed it. */
  fromSelf: boolean
}

type VerificationResult = VerifyMessageResult['signatures'][number]

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

async function ownPublicKeys(accountId: string): Promise<Key[]> {
  const openpgp = await loadOpenpgp()
  const out: Key[] = []
  for (const own of await ownKeys(accountId)) {
    try {
      out.push((await openpgp.readPrivateKey({ armoredKey: own.armored })).toPublic())
    } catch {
      // A stored key that no longer reads verifies nothing.
    }
  }
  return out
}

/**
 * The first signature, judged against the keys that may have made it.
 *
 * "Which key" comes before "does it verify": a signature by a key mel does
 * not hold for this sender is not a failure, it is simply unchecked, and
 * saying "invalid" there would teach people to ignore the warning that
 * matters — a known key whose signature no longer matches the content.
 */
async function judge(
  signatures: VerificationResult[],
  keys: Key[],
  own: Set<string>,
): Promise<SignatureCheck | null> {
  const sig = signatures[0]
  if (!sig) return null
  const key = keys.find((k) => k.getKeyIDs().some((id) => id.equals(sig.keyID)))
  if (!key) return { state: 'unknownKey', keyId: sig.keyID.toHex() }
  try {
    await sig.verified
  } catch {
    return { state: 'invalid' }
  }
  const fingerprint = key.getFingerprint()
  return {
    state: 'valid',
    signer: key.getUserIDs()[0] ?? '',
    fingerprint,
    own: own.has(fingerprint),
  }
}

async function verifyDetached(
  signed: Uint8Array,
  armoredSignature: string,
  keys: Key[],
  own: Set<string>,
): Promise<SignatureCheck | null> {
  const openpgp = await loadOpenpgp()
  try {
    const result = await openpgp.verify({
      message: await openpgp.createMessage({ binary: signed }),
      signature: await openpgp.readSignature({ armoredSignature }),
      verificationKeys: keys,
      format: 'binary',
    })
    return await judge(result.signatures, keys, own)
  } catch {
    // An unreadable signature packet: something claims to be signed and is
    // not checkably so, which is what "does not match" has to cover.
    return { state: 'invalid' }
  }
}

async function parseEntity(data: Uint8Array): Promise<OpenedContent> {
  const { default: PostalMime } = await import('postal-mime')
  const mail = await PostalMime.parse(data, { attachmentEncoding: 'arraybuffer' })
  return {
    html: mail.html ?? null,
    text: mail.text ?? null,
    attachments: mail.attachments
      // The signature of a signed-then-encrypted message has been read
      // already; it is not a file the sender attached.
      .filter((a) => a.mimeType.toLowerCase() !== 'application/pgp-signature')
      .map((a) => ({
        name: a.filename ?? 'attachment',
        type: a.mimeType,
        cid: a.contentId?.replace(/^<|>$/g, '') ?? null,
        disposition: a.disposition,
        data:
          a.content instanceof Uint8Array
            ? a.content
            : typeof a.content === 'string'
              ? new TextEncoder().encode(a.content)
              : new Uint8Array(a.content),
      })),
  }
}

const hasText = (s: string) => s.trim().length > 0

/*
 * The armored block sat on lines of its own, so the text around it already
 * carries the line breaks that separate it; the one the library leaves at the
 * end of the plaintext would be a blank line more.
 */
const spliced = (block: { before: string; after: string }, data: string) =>
  block.before + data.replace(/\r?\n$/, '') + block.after

export async function openSecure(
  accountId: string,
  input: SecureInput,
): Promise<SecureView | null> {
  const { body, kind } = input
  const [contactKeys, ownPublic] = await Promise.all([
    input.sender ? contactKeysFor(accountId, input.sender) : Promise.resolve([]),
    input.fromSelf ? ownPublicKeys(accountId) : Promise.resolve([]),
  ])
  const keys = [...contactKeys, ...ownPublic]
  const own = new Set(ownPublic.map((k) => k.getFingerprint()))
  const openpgp = await loadOpenpgp()

  if (kind === 'mimeSigned') {
    let raw: Uint8Array
    try {
      const conn = await connectionFor(accountId)
      const meta = await conn.mail!.getEmailMetadata(input.emailId)
      if (!meta?.blobId) return { state: 'unavailable' }
      raw = await bytesOf(
        await conn.mail!.downloadBlob(meta.blobId, 'message/rfc822', 'message.eml'),
      )
    } catch {
      return { state: 'unavailable' }
    }
    const split = splitSigned(raw)
    // Signed somewhere below the top level: saying anything about "the
    // message" would be saying too much (see splitSigned).
    if (!split) return null
    return {
      state: 'open',
      encrypted: false,
      signature: await verifyDetached(split.signed, split.signature, keys, own),
      partial: false,
      content: null,
    }
  }

  if (kind === 'inlineSigned') {
    const block = inlineBlock(body.text ?? '', 'inlineSigned')
    if (!block) return null
    try {
      const message = await openpgp.readCleartextMessage({ cleartextMessage: block.armor })
      const result = await openpgp.verify({ message, verificationKeys: keys })
      return {
        state: 'open',
        encrypted: false,
        signature: await judge(result.signatures, keys, own),
        partial: hasText(block.before) || hasText(block.after),
        // The armor headers and dash-escaping are machinery; the reader
        // wants the words that were signed.
        content: { html: null, text: spliced(block, result.data), attachments: [] },
      }
    } catch {
      return {
        state: 'open',
        encrypted: false,
        signature: { state: 'invalid' },
        partial: false,
        content: null,
      }
    }
  }

  // Encrypted from here on.
  const decryptionKeys = unlockedKeys(accountId)
  const stored = await ownKeys(accountId)
  if (!stored.length) return { state: 'noKey' }
  const lockedRemain = stored.length > decryptionKeys.length
  if (!decryptionKeys.length) return { state: 'locked' }
  // A failure while some stored key is still locked may be that key's
  // message: ask for the passphrase rather than calling it unreadable.
  const failed = (): SecureView => ({ state: lockedRemain ? 'locked' : 'undecryptable' })

  if (kind === 'inlineEncrypted') {
    const block = inlineBlock(body.text ?? '', 'inlineEncrypted')
    if (!block) return null
    try {
      const message = await openpgp.readMessage({ armoredMessage: block.armor })
      const result = await openpgp.decrypt({ message, decryptionKeys, verificationKeys: keys })
      return {
        state: 'open',
        encrypted: true,
        signature: await judge(result.signatures, keys, own),
        partial: hasText(block.before) || hasText(block.after),
        content: { html: null, text: spliced(block, result.data), attachments: [] },
      }
    } catch {
      return failed()
    }
  }

  const part = encryptedPart(body)
  if (!part?.blobId) return { state: 'undecryptable' }
  let cipher: Uint8Array
  try {
    const conn = await connectionFor(accountId)
    cipher = await bytesOf(
      await conn.mail!.downloadBlob(part.blobId, part.type, part.name ?? 'encrypted.asc'),
    )
  } catch {
    return { state: 'unavailable' }
  }
  let data: Uint8Array
  let signatures: VerificationResult[]
  try {
    const text = new TextDecoder().decode(cipher)
    const message = text.includes('-----BEGIN PGP MESSAGE-----')
      ? await openpgp.readMessage({ armoredMessage: text })
      : await openpgp.readMessage({ binaryMessage: cipher })
    const result = await openpgp.decrypt({
      message,
      decryptionKeys,
      verificationKeys: keys,
      format: 'binary',
    })
    data = result.data
    signatures = result.signatures
  } catch {
    return failed()
  }

  /*
   * Signed two ways, depending on the sender's client: one OpenPGP message
   * that is both signed and encrypted (the signature came back with the
   * plaintext), or a `multipart/signed` entity inside the encryption (RFC
   * 3156 §6.1), which is checked exactly like a signed message on its own.
   */
  let signature = await judge(signatures, keys, own)
  if (!signature && isSignedEntity(data)) {
    const split = splitSigned(data)
    signature = split ? await verifyDetached(split.signed, split.signature, keys, own) : null
  }
  let content: OpenedContent
  try {
    content = await parseEntity(data)
  } catch {
    return { state: 'undecryptable' }
  }
  return { state: 'open', encrypted: true, signature, partial: false, content }
}
