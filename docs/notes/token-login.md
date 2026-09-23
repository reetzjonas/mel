# Token login: TOTP, and no stored password

Issue #97. Where the server offers it, and Stalwart does, mel trades the
password for a refresh token at sign-in and stores only the token. That makes
accounts with a TOTP second factor usable at all, and means mel does not
keep a password in IndexedDB, not even an encrypted one. Other servers
(Fastmail with an API token, anything without the endpoint) keep Basic or
bearer auth exactly as before.

## The flow

Stalwart's own web admin signs in the same way, straight from the browser,
with no backend and no registered client (checked against 0.16; CORS on both
endpoints is open):

1. `POST <origin>/api/auth` with `{type: "authCode", accountName, accountSecret,
mfaToken?, clientId: "mel", redirectUri, codeChallenge, codeChallengeMethod:
"S256"}`. Answers `{type: "authenticated", client_code}`,
   `{type: "mfaRequired"}` (the account has TOTP and no code was sent) or
   `{type: "failure"}` (wrong password or wrong code, which are not told apart).
2. `POST` to the `token_endpoint` from `/.well-known/oauth-authorization-server`
   (falling back to `/auth/token`) with `grant_type=authorization_code`, the
   code and the PKCE verifier. Answers an access token (an hour on Stalwart) and a
   refresh token.
3. `grant_type=refresh_token` buys the next access token. Stalwart did not
   rotate the refresh token when tested; if a server does, the new one replaces
   the stored one (`onRefreshTokenRotated`, registered in `sync/connections.ts`).

`<origin>` is the origin of the session URL. A server where POSTing to
`/api/auth` fails in any way (404, CORS, HTML) is simply one without the login:
`tokenLogin()` answers null and `addAccount` carries on with Basic. So does a
server that returns no refresh token, since an access token alone could not be
renewed after an hour.

## Where the pieces live

- `providers/jmap/client/auth.ts` holds all of it. `authorization(creds)` gives
  the header. For an `oauth` credential it holds the access token in memory
  only, renews it a minute before it expires, and renews just once at a time per
  token: the sync, the event stream and the downloads all start together.
  `authorizedFetch()` also renews and retries once on a 401, because a held
  token can be revoked, or this device's clock can be off.
- Transport, `fetchSession` and the SSE stream (`fetch` option of
  fetch-event-source, so a reconnect gets a fresh token) all go through
  `authorizedFetch`. No other code builds an Authorization header.
- A refused refresh token (`400 invalid_grant`) is a `JmapError` of kind
  `auth`. A 5xx, a 429 or no network are `server`, `ratelimit` and `network`:
  an outage must not sign anyone out.
- The service worker, when push shows the sender and subject, goes through the
  same `fetchSession`/`createTransport`, so it renews for itself. It keeps no
  token between wake-ups, so each push costs one extra token request. As
  before, this works for unencrypted accounts only.

## Signing in again

An `auth` error from the sync puts a band under the header, `ReauthPrompt` in
`features/auth`. It is not a dialog that opens by itself, because the mail on
the device stays readable and should stay in front. The band offers a dialog
that asks for the password (and the code, once the server asks for one). It
calls `reauthenticate()`, which checks the new credentials against the session
before replacing anything stored, then restarts the scheduler. This also covers
a password changed elsewhere on a Basic account, and it moves that account onto
tokens along the way.

## Existing accounts

`upgradeToTokens()` runs once per start, after unlock, because the password is
sealed until then. It trades the stored password for a token and drops the
password. For anything short of success (no endpoint, a TOTP code needed, no
network) it stays quiet and Basic keeps working. This is why `persistAccount`
in `sync/connections.ts` now re-reads the stored credentials instead of
writing back the ones its connection was opened with. The connection opens at
the same moment as the upgrade, and would otherwise restore the password
just dropped.

## Why there is no "remember me"

Bulwark Lite has one because it keeps nothing otherwise: without it the token
lives in `sessionStorage` and the session ends with the tab. mel is
offline-first and keeps mail in IndexedDB either way, so a session that ends
with the tab would make no sense. Sign-out and the passphrase are the answer for
a shared machine.

## Open ends

- Signing out does not revoke the refresh token on the server: Stalwart
  advertises no revocation endpoint (only introspection). The token stays
  valid until it expires, or until it is revoked in Stalwart's admin.
- How long Stalwart lets a refresh token live was not measured. When it runs
  out, the band above appears.
- Basic auth against a TOTP account answers **402**. `fetchSession` turns it
  into an `auth` error that says the token login was out of reach, so the login
  stops there instead of trying other hosts. In practice the cause is a
  reverse proxy that forwards `/jmap` but not `/api/auth` and `/auth/` (see
  `deployment.md`).

## Testing

`seed.sh` provisions `carol@localhost` with a fixed TOTP secret.
`e2e/auth.spec.ts` covers the stored token (and that the password is nowhere in
the row), the TOTP step through the form, and a spoilt refresh token leading to
the band and a successful sign-in again. Stalwart refuses a TOTP secret under
128 bits, and it does so as a plain `failure` for the right code, with nothing
in the logs. The 80-bit example secret found everywhere (`JBSWY3DPEHPK3PXP`)
is too short.
