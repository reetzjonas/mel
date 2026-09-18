# PGP and S/MIME (issue #63): what is built, and what part 2 runs into

Part 1 — **public keys on contact cards** — is built and described below. Parts
2 and 3 — reading and writing encrypted mail — are not, and this note exists
because the interesting half of that work is finding out what the existing
seams can and cannot do. Everything here was established against the real
server and the real code, not from the RFCs alone.

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

What the UI does *not* do is read the key: no fingerprint, no user id, no
expiry. All of that needs the crypto library that part 2 brings, and a
fingerprint is the only thing that would let someone check a key is the right
one — so until then the card says which kind of key it is, how big it is, and
hands it back out as a download. `keyFromText` is deliberately strict about
what it accepts: a field labelled "public key" holding a stray paragraph is
worse than an empty one, because everything downstream would treat it as a key
and fail somewhere the user cannot connect back to the paste.

A key mel cannot read — a DER certificate, say — still round-trips untouched.
It is shown as "Public key" with its URI, and written back as it arrived.

## Part 2: verifying and decrypting — what it runs into

**Verification needs the raw message, not the parsed one.** RFC 3156 signs the
exact canonical bytes of a MIME part, headers included. JMAP hands out
`bodyStructure` with a `blobId` per *leaf* part; the `multipart/signed` subpart
that was actually signed has no blob of its own. The way through is the whole
message: `Email.blobId` is already fetched (`EMAIL_METADATA_PROPS`, used by
"save original" in `MessageDetails.tsx`) and `downloadBlob` already exists — so
the raw RFC 5322 bytes are one call away. What is missing is a MIME parser,
which mel has never needed: `toEmailBody` consumes the structure the server
already parsed. Inline PGP (armor sitting in `text/plain`) needs none of this
and is the cheap first case.

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
composer can *fail* to reach, and say why, per recipient.

**A lookup by address is missing.** Keys hang off contacts; compose knows
addresses. `suggestRecipients` in `services/contacts.ts` is the shape to copy,
but the answer has to be exact rather than a prefix match, and has to survive
an address that matches several cards.

**The library is a dynamic import.** OpenPGP.js is far too big to sit in the
main bundle — the same treatment as fflate and CodeMirror. It has to be added
to the lockfile the way CI reads it (see AGENTS.md: `npm install
--package-lock-only` inside `node:24-alpine`, never `npm i` on the host).

**S/MIME is a second feature, not a second format.** PGP needs one library and
a key per correspondent. S/MIME needs X.509 chain building, trust anchors, and
a decision about which roots to trust in a browser that will not lend its own —
which is a design question in its own right, not an extra `case` in a switch.
It deserves its own issue; part 1 above already stores the certificates for
whenever that happens.

## Part 2: where the private key lives (decided)

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

This is deliberately *independent* of mel's own at-rest encryption rather than
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

**Import only, for now.** Generating a key would make mel the holder of the only
copy of something that cannot be re-created, which is not finished work until
the export step exists and is insistent enough that a cleared browser profile is
not a loss. Import covers everyone who already has a key; generation can follow
once the rest of the round trip is real.

Two consequences worth stating in the UI rather than discovering:

- **The private key does not sync.** There is no backend to sync it to, so it
  lives on one device by construction.
- **Publishing the public half** is a separate problem. Attaching it to outgoing
  mail is the answer that needs no infrastructure; WKD and keyservers need some.
