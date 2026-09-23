# OpenPGP (issue #63): keys, reading and writing

All three parts are built:

1. Public keys on contact cards.
2. Reading encrypted and signed mail with the user's own key.
3. Writing encrypted and signed mail.

Everything here was established against the real server and the real code,
not from the RFCs alone.

S/MIME moved to its own issue (#100). Follow-ups that grew out of this one:
Autocrypt (#101, done, see below), WKD lookup (#102), Stalwart's encryption at rest (#103) and
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

## Part 3: writing (done)

**Why mel writes the MIME itself.** Every other message goes out as a JMAP
Email object that the server turns into MIME. A signed message cannot go that
way: RFC 3156 signs the exact bytes of the first part, and a server that
writes that part itself writes different bytes. An encrypted message must not
show the server what is inside. So for both, mel writes the whole RFC 5322
message and sends it with **`Email/import` into Drafts plus
`EmailSubmission/set` in one request**, with `onSuccessUpdateEmail` moving it
to Sent (`sendRawEmail` in `providers/jmap/mail.ts`). This was checked against
Stalwart 0.16:

- The creation-id back-reference from the import to the submission works.
- An explicit `envelope` is honoured.
- A delivered signed message still verifies at the recipient. The e2e test
  fetches Bob's raw copy and checks it outside mel.

The builder is `lib/mimeBuild.ts`, deliberately narrow:

- Every part is base64, so the output is 7-bit clean, as RFC 3156 requires of
  signed content, and no line-length or trailing-space rule matters.
- Every line ends in CRLF.
- Nesting is mixed › alternative › related.
- Header words are RFC 2047 encoded, file names RFC 2231.
- It never writes a Bcc header. The recipients travel in the submission's
  envelope instead, so the Sent copy does not list Bcc.

The existing libraries (mimetext) pull in babel-runtime/core-js, so writing
this ~200-line builder was cheaper. The tests round-trip it through
postal-mime. All cryptography is still OpenPGP.js.

**The shapes it writes.**

- _Encrypted_: one OpenPGP message, signed when Sign is on, and encrypted to
  every recipient and to the user, so the Sent copy stays readable. It is
  wrapped in RFC 3156 `multipart/encrypted`. This is the form most clients
  write and every client reads.
- _Signed only_: `multipart/signed` over the body entity, with `micalg` taken
  from the hash the signature actually used.

**Built before queueing, not when the queue runs** (`sendSecure` in
`services/send.ts`, outbox action `email.sendRaw`). The queue then holds the
finished message, which is ciphertext when encrypted, rather than the
plaintext. The unlocked key also does not have to stay unlocked until a queue
that is offline until tomorrow gets round to it. Attachments are read from
the local stage, or downloaded when they only exist on the server (a
forwarded file). The 10-second undo window is unchanged.

**Compose.**

- The Encrypt and Sign switches in the footer appear only when a key is
  stored.
- Turning Encrypt on turns Sign on with it.
- A line above the footer names every recipient without a usable key (not
  expired, not revoked), found as the fields change. Send is refused until
  that list is empty, Bcc included: encrypting to some recipients and sending
  the rest nothing, or plaintext, would be worse than refusing.
- A locked key gets a passphrase field in the same line.
- The line also says the subject is not encrypted, and that nothing is
  autosaved to the server while Encrypt is on. A draft is stored as it is,
  and this one is meant not to be readable there. The Save button is off for
  the same reason.
- A reply to an encrypted message starts out encrypted, and still quotes the
  server's body, not the plaintext (see part 2).

**Not done:**

- WKD lookup for recipients without a key (#102).
- Protected headers, which would encrypt the subject.
- Saving encrypted drafts.
- Quoting the plaintext in an encrypted reply. That needs a guard for turning
  encryption off afterwards.

Tests:

- `lib/mimeBuild.test.ts`: round trip through postal-mime.
- `services/pgpWrite.test.ts`: decrypts and verifies what was built, with
  OpenPGP.js and with mel's own `splitSigned`.
- `send.test.ts` and `outboxExecute.test.ts`: the queue path.
- `e2e/pgp.spec.ts`: Alice sends Bob an encrypted, signed message. Bob's copy
  is decrypted with Bob's key in Node, and Alice's Sent copy opens in mel. A
  signed-only message is verified from Bob's raw copy.

## Autocrypt (issue #101, done)

Header only (Autocrypt Level 1): the user's public key goes out with every
message, and a correspondent's key can be picked up from theirs. Gossip and
the setup message are out of scope.

**Sending.** Every message from an address the stored key names gets an
`Autocrypt:` header (`services/autocrypt.ts`, `ownAutocryptKeydata`). The key
is cut down to what the spec asks for: the primary key, the one user id for
that address, the encryption subkey, and their self-signatures. Other user
ids, photos, signing subkeys and third-party certifications are left out, so
the header stays at a kilobyte or two. No unlocking is needed, since the
public half of a stored secret key is readable as it is. `prefer-encrypt` is
not written (no preference); mel has no setting to ask it.

How it reaches the wire was checked against Stalwart 0.16:

- `header:Autocrypt:asText` comes out as RFC 2047 encoded words once it is
  long. No Autocrypt reader decodes those.
- `header:Autocrypt:asRaw` with line breaks of our own comes out with an
  empty continuation line after each of them.
- `header:Autocrypt:asRaw` with the key cut into pieces separated by
  **spaces** is folded by Stalwart at those spaces, cleanly. That is what
  `sendEmail` sends. Readers ignore whitespace inside `keydata`.

OpenPGP mail, which mel writes itself, folds the header in `lib/mimeBuild.ts`.

**Receiving.** The body fetch asks for `header:Autocrypt:asText:all`, all of
them, because the spec treats two valid headers for the sender as none.
`domain/autocrypt.ts` parses them: `addr` must be the From address, an unknown
attribute without a leading underscore makes the header invalid. The reading
pane then shows `AutocryptNotice`:

- The sender has no key in the contacts: a band with the fingerprint and
  "Add key to contact". It goes onto the first card with that address, or a
  new card in the default address book when there is none. Never silently:
  a key decides who can read what the user writes.
- The contacts hold that very key (by fingerprint): nothing.
- The contacts hold a different key: a warning in the danger tone, with the
  new fingerprint, and nothing changes. It may be a new key, or someone else.
  Replacing it is a deliberate edit on the card.

Mail from the user's own address, or with several From addresses, is
skipped. Bodies cached before this existed carry no header values, so older
messages offer nothing until their body is fetched again.

Tests: `domain/autocrypt.test.ts` (parsing), `services/autocrypt.test.ts`
(minimal key, offer, saving), and in `e2e/pgp.spec.ts` an ordinary message
whose raw copy at Bob carries the minimal key, plus a received header saved
to a new card through the band.

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
  mail is the answer that needs no infrastructure (Autocrypt, above); WKD and
  keyservers need some.
