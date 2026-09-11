# Login, setup and signing out

One form for every server: **email plus password**, no provider presets any more
(Fastmail and the explicit Stalwart entry are gone). `discoveryCandidates()` guesses
the session URL from the address — `mail.<domain>` first, then the apex, `jmap.`,
`imap.`; for `@localhost` the dev Stalwart on `http://localhost:8080`.
Only **once every candidate has failed** does the form reveal (a) a "look up via DNS"
button (`srvCandidates()`, DoH against Cloudflare, resolving the `_jmap._tcp.<domain>`
SRV record) and (b) a manual server address plus auth method.
**The DoH path never runs on its own** — it discloses the mail domain to a third
party, so it happens on an explicit click only (user's rule).

Why guess rather than use SRV: RFC 8620 provides for the SRV record, but **browsers
have no DNS API** and this app has no backend. Real case `reetz.me`: the SRV record
(`0 1 443 mail.reetz.me`) and CORS are both correct, but the apex has **no A record at
all** — so the naive well-known attempt against `reetz.me` goes nowhere while
`mail.reetz.me` answers immediately.

`signOut()` in `services/accounts.ts` is the only way out (button in the desktop
header and in settings). Two traps, both fixed:

- `removeAccount` did **not** list `addressBooks`/`contacts`/`calendars`/`events`/
  `keyring` among its tables — after "signing out", the previous user's contacts and
  events were still sitting in IndexedDB. A unit test in `accounts.test.ts` now keeps
  the list complete; **a new per-account table must be added there**.
- **A sync in flight writes straight over the purge.** `signOut` therefore, in this
  order: `await stopScheduler()` → delete the account row (nothing can connect
  afresh) → `dropConnection` → await `syncSettled` → only then purge.
  The `await` on `stopScheduler` is the load-bearing part and was missing at first:
  `syncSettled()` only knows about `syncAccount()`, so a tick still sitting in
  `flush()` is invisible to it and goes on to write a complete fresh sync afterwards.
  The scheduler now tracks in-flight ticks (`inflight` map) and `stopScheduler`
  returns a promise for them.
  This is **reproducible**: without the await, `e2e/navigation.spec.ts` finds
  `emails: 4, mailboxes: 6` left behind on the first run. The test asserts per table
  rather than on a total, because "1 row survived" tells you nothing about where.
