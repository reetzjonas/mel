# OpenPGP (issue #63): what is built, and what sending runs into

Part 1 (public keys on contact cards) and part 2 (reading encrypted and
signed mail with the user's own key) are built and described below. Part 3,
writing encrypted and signed mail, is not; its section records what the
existing seams can and cannot do for it. Everything here was established
against the real server and the real code, not from the RFCs alone.

S/MIME moved to its own issue (#100). Follow-ups that grew out of this one:
Autocrypt (#101), WKD lookup (#102), Stalwart's encryption at rest (#103) and
generating a key in mel (#104).

## Part 1: keys on the card (done)

JSContact has a place for this already: `cryptoKeys` (RFC 9553 §2.6.3), a map
of ids to `{ "@type": "CryptoKey", uri, mediaType? }`. mel maps it to
`Contact.cryptoKeys` (`src/domain/contactKey.ts`) and stores the key as a
`data:` URI, the way the photo travels.

**Only ever the public half.** A card is server-side data that syncs to every
device and is handed around like any other contact detail. The user's own
private key does not go on one — that is part 2's problem and needs its own
home.

Established by probing Stalwart directly:

- It stores `cryptoKeys` **verbatim** — `mediaType`, `pref` and `label` all
  come back as written, and it does not invent an `@type` for an entry that
  omits one. Unlike `onlineServices`, which it silently drops when `@type` or
  `uri` is missing (see the comment in `mappers/contacts.ts`), nothing here is
  quietly discarded.
- `ContactCard/set update` is a patch, so a property mel does not send is one
  the server keeps. That is why editing a contact in mel never destroyed the
  `cryptoKeys` it did not yet map — but it also means writing the map now
  **replaces** it, so a `pref` or `label` another client set is lost to an edit
  in mel. Same trade the photo makes.

Once part 2 brought the library, the card also shows what a PGP key says
about itself: user id, fingerprint (the one thing that lets someone check,
with the owner, that it is the right key), creation date and expiry
(`features/pgp/KeyFacts.tsx`, read lazily). It still hands the key back out as
a download. `keyFromText` is deliberately strict about
what it accepts: a field labelled "public key" holding a stray paragraph is
worse than an empty one, because everything downstream would treat it as a key
and fail somewhere the user cannot connect back to the paste.

A key mel cannot read — a DER certificate, say — still round-trips untouched.
It is shown as "Public key" with its URI, and written back as it arrived.

## Part 2: reading (done)

**What Stalwart shows of it** (checked against 0.16 by importing PGP/MIME
messages and reading them back):

- A `multipart/encrypted` message has empty `textBody` and `htmlBody`. Both
  halves, the `application/pgp-encrypted` version part and the
  `application/octet-stream` ciphertext, are listed as attachments, each with
  its own blob. So the ciphertext is one `downloadBlob` away, and no raw
  message is needed.
- A `multipart/signed` message shows the signed content as its body and the
  `application/pgp-signature` part as an attachment. The signed part has no
  blob of its own (the server strips the part headers the signature covers), so
  verification downloads the whole message via `Email.blobId`
  (`getEmailMetadata`) and cuts the signed bytes out of it.

**How it is split up:**

- `domain/pgp.ts` is pure and decides from the body the server already gave us.
  `pgpKind()` returns one of `mimeEncrypted`, `mimeSigned`, `inlineEncrypted`
  or `inlineSigned`. `splitSigned()` returns the exact first-part bytes of a
  top-level `multipart/signed`, CRLF-canonicalised, plus the armored signature.
  `inlineBlock()` finds an armored block and the text around it.
- `services/pgpKeys.ts` handles the own key (import, unlock, lock, remove) and
  looks up contact keys by exact address.
- `services/pgpRead.ts` has `openSecure()`, which returns a `SecureView`:
  `noKey`, `locked`, `undecryptable`, `unavailable`, or `open` with
  `encrypted`, the signature check, `partial`, and the decrypted content.
- `features/mail/secureMessage.ts` is the hook, which re-runs when a key is
  unlocked. `SecureNotice.tsx` is the band, including the passphrase field.
- All the cryptography is OpenPGP.js; the MIME inside an encrypted message is
  parsed by postal-mime. Both load only when a message needs them (their own
  chunks, ~130 KB and ~23 KB gzipped). The only parsing mel does itself is
  finding boundaries and armor lines, and a mistake there can only make a good
  signature read as not matching, never the other way round.

**Decisions worth knowing:**

- **Which key may have signed.** Only the keys on the cards of contacts with
  the message's From address, found by exact, case-insensitive match. A
  signature by any other key is "cannot be checked", not "invalid". "Invalid"
  is kept for a known key whose signature no longer matches, so it keeps its
  weight. A message with several From addresses is not checked at all. The
  user's own key counts only on mail from their own address.
- **Signed two ways inside encryption.** Either one OpenPGP message that is
  both signed and encrypted, or a `multipart/signed` entity inside the
  encryption (RFC 3156 §6.1). Both are handled.
- **Top-level only.** A `multipart/signed` nested inside an unsigned
  `multipart/mixed` is left alone: calling the message signed would
  overstate it. Inline blocks with text around them are shown, and the band
  says only part was covered (`partial`).
- **Inline armor only in plain-text bodies.** A block inside HTML has been
  through an editor, and the markup around it could make the sender's words
  look covered.
- **The plaintext is never stored.** It lives in the reading pane's state.
  Replying and forwarding quote the server's body, not the decrypted one, so a
  decrypted message is never quoted in the clear into a reply that goes out
  unencrypted. That stays true until part 3 can encrypt the reply.
- **Remote images in an encrypted message stay blocked** unless released for
  that message, whatever the account setting says, like Junk. A remote image
  would tell the sender the moment the message was decrypted.
- **The PGP parts are hidden** (version part, ciphertext, signature) while the
  band speaks for them. When mel cannot open the message (for someone else's
  key, or could not be fetched) they are listed, so the file can be taken
  elsewhere.
- **Locking mel** (Settings → Security → Lock now) and signing out also forget
  the unlocked OpenPGP key.

Tests: `domain/pgp.test.ts` covers parsing. `services/pgp.test.ts` covers real
keys and messages generated with OpenPGP.js. It runs under
`@vitest-environment node`, because under jsdom `TextEncoder` returns
`Uint8Array`s from another realm and OpenPGP.js rejects them. `e2e/pgp.spec.ts`
has the round trip against Stalwart:

1. An encrypted, signed message says a key is needed.
2. The key is imported in Settings, and a wrong passphrase is refused.
3. The message opens, naming the signer.
4. After a reload it asks for the passphrase again.
   A second case sends a signed and an altered message.

**Not done:** the protected subject inside an encrypted message ("memory
hole") is not shown in place of the outer one. The band says the subject was
not encrypted instead. Search and previews cannot see into encrypted mail
(the server cannot either).

## Part 3: writing — what it runs into

**Sending needs a second send path.** `sendEmail` builds an Email object out of
`textBody`/`htmlBody` plus attachment blobs. An encrypted message is a
`multipart/encrypted` with two parts, the second being the ciphertext — so it
has to go out as a `bodyStructure` referencing a blob from `uploadBlob`, not as
body values. EmailSubmission is unchanged. Worth deciding before writing any of
it: the **subject is not covered** by PGP/MIME and travels in the clear, which
is a thing to say in the UI rather than to discover.

**Encryption happens at send time, which suits the outbox.** Every recipient
key is local (it is on their card), so an encrypted message can be composed and
queued offline like any other. What cannot be done offline is fetching a key
for a recipient who has none stored — so "encrypt" has to be a state the
composer can _fail_ to reach, and say why, per recipient.

**A lookup by address exists now:** `contactKeysFor()` in
`services/pgpKeys.ts`, exact and over every card with the address. Compose
can use it as is.

## Where the private key lives (decided, built)

**The key protects itself, and mel never stores one that does not.**

An OpenPGP secret key is already a passphrase-encrypted artifact (S2K; Argon2id
in v6 keys), so mel stores it exactly as it was exported and calls `decryptKey`
when it needs it. The unlocked key is held in memory for the session and
nowhere else — the same shape as the DEK in `storage/crypto/keyring.ts`, which
keeps a module-level map cleared by `lock()`. Never `sessionStorage`.

The rule that makes this work: **an unprotected secret key is refused.** OpenPGP
allows one, and plenty of exported keys are, and storing one would quietly turn
this whole scheme into "private key in plaintext IndexedDB" for exactly the
people least likely to notice. Import asks for a passphrase and re-encrypts
before anything reaches the database.

This is deliberately _independent_ of mel's own at-rest encryption rather than
built on it. Both were on the table:

- Leaning on the existing envelope and DEK would have cost nothing to build —
  the middleware, `UnlockGate` and the keyring are all there, and one passphrase
  would cover everything. But at-rest encryption is **off by default**, so that
  version either ships a secret key in readable IndexedDB or forces an unrelated
  feature (and a full row migration) on someone who only wanted to read a signed
  message.
- Protecting the key with its own passphrase holds whether or not mel's
  encryption is on, and the artifact stays the one GnuPG and Thunderbird write,
  so import and export are lossless and the user can reason about the file.

The two are not exclusive and are not being traded off: a key stored this way
still goes through the payload envelope, so with at-rest encryption on it is
sealed twice and with it off it is still sealed once. The cost is a passphrase
prompt per session, and two distinct passphrases for a user who has mel's
encryption on as well — worth saying plainly in the UI, since they will expect
one to open the other.

Not an option, for the record: a non-extractable WebCrypto key. OpenPGP.js does
its own crypto and needs the key material in JS memory, so the platform's "the
key never leaves the browser" guarantee cannot back an OpenPGP operation.
Smartcards are out for the same reason — no browser API for them.

**Import only, for now** (Settings → Security → OpenPGP key: paste or file,
armored or binary). A protected key has its passphrase checked on import. An
unprotected one has to be given a passphrase before it is stored. The stored
form is what "Export secret key" hands out. Generating a key would make mel
the holder of the only copy of something that cannot be re-created, so it
waits for an export step insistent enough that a cleared browser profile is
not a loss (#104).

Two consequences worth stating in the UI rather than discovering:

- **The private key does not sync.** There is no backend to sync it to, so it
  lives on one device by construction.
- **Publishing the public half** is a separate problem. Attaching it to outgoing
  mail is the answer that needs no infrastructure; WKD and keyservers need some.
