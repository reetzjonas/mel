# Push notifications: naming the sender and subject

Web Push itself (subscription, the PushVerification handshake, RFC 9749) lives
in `src/services/webPush.ts` and is described by the comment at the top of that
file. This note is about the part that came later: letting a notification say
*who wrote* and *about what*, instead of only "New mail".

## Why it costs anything at all

The JMAP server pushes a `StateChange` (RFC 8620 §7.2). It carries no content —
only "Email changed on account X". So there is nothing to display until the
service worker goes and asks. That is a session fetch plus one batched
`Email/query` + `Email/get`, on a device that was woken up for it, which is why
the setting is **off by default** and why the generic body stays the fallback
for everything that goes wrong.

## Why it is only for unencrypted accounts

The notification is prepared with no app running. An encrypted account's rows —
including the one holding its credentials — are sealed with a DEK that only
exists in the main thread while the passphrase has been entered
(`storage/crypto/keyring.ts`). A service worker therefore cannot read the
credentials, cannot make the request, and could not read a cached message
either.

This is a hard limit, not a policy choice, so the switch is **disabled rather
than hidden** and says why. Turning encryption on afterwards clears the flag in
`enableEncryption()` — leaving it set would promise something that then
silently never happens.

## Where the flag lives, and why not in the payload

`AccountRow.pushDetails`, a plaintext column beside `encrypted`
(`storage/db.ts`). Every other readable thing about an account sits inside the
`plain`/`enc` payload envelope, but the only reader that matters here is the
service worker, which has no Dexie, no crypto middleware and no key. A column
needs none of those. It also needed no schema version: Dexie only declares
indexed keys, so an added property just stores.

`pushDetailsEnabled()` answers false for an encrypted account whatever the
stored flag says, so the UI and the service worker cannot disagree.

## How the service worker reads the database

`src/sw/mailNotification.ts`, through the raw IndexedDB API rather than Dexie.
Pulling Dexie plus the crypto middleware into the service worker bundle would
be paying for a database it cannot write to anyway.

Two things fall out of the store layout and are worth knowing:

- The **inbox id** comes from the local `mailboxes` store via the
  `[accountId+role]` index. `role` is one of the plaintext index columns every
  row carries beside its payload, so the notification costs no `Mailbox/query`.
  `mailNotification.test.ts` seeds through Dexie on purpose, so a renamed index
  fails there rather than in production.
- The **account** is found by scanning `accounts` for a matching
  `remoteAccountId`: `StateChange` names the *JMAP* account, and mel's own
  account ids are local UUIDs.

`indexedDB.open('mel')` is called without a version. A service worker must
never be the one deciding the schema — if the store is not there yet, the
answer is simply the generic body.

## What it shows

The newest **unread** message in the inbox: sender name (or address) as the
title, subject as the body. Deliberately singular — counting "new" messages
would mean either keeping notification state in the worker or calling
long-unread mail new, and both are worse than showing the one message that
almost certainly caused the push.
