# Filter rules (JMAP Sieve)

Server-side mail filtering, as a section in Settings → Mail, gated on
`urn:ietf:params:jmap:sieve` (RFC 9661). Rules run on the server, so they apply
on every device and to mail arriving while mel is closed — which is the reason
to offer this at all rather than filtering locally.

It is a **script editor**, not a rule builder: a name, a textarea, and the
server's own verdict. Sieve (RFC 5228) is a real language with extensions the
server advertises, and a builder that covered a useful fraction of it would be
a large feature that still could not open a script it did not write. The
server-side check is what makes the plain editor safe.

## Shape

| Layer | Where |
| --- | --- |
| Domain object | `src/domain/sieve.ts` |
| JMAP provider | `src/providers/jmap/sieve.ts` |
| Writes | `src/services/sieve.ts` |
| UI | `src/features/settings/SieveSetting.tsx`, in the Mail tab |

Nothing is cached locally and there is no outbox action. The server is the only
thing that can say whether a script parses, so an edit that has not reached it
has not been checked either; every call reports what happened and the list is
re-read afterwards.

`Check` and `Save` both cost an upload: `SieveScript/validate` and
`SieveScript/set` take a **blobId**, never inline text, so the script is
uploaded as `application/sieve` first either way.

## What the server does that the spec does not say

**The two error codes have different names in practice.** RFC 9661 registers
`invalidSieve` and `sieveIsActive`; Stalwart answers `invalidScript` and
`scriptIsActive` for the same two conditions. A client matching only the
registered spelling would turn a reported syntax error — the whole point of the
editor — into an unexplained failure. `isSyntaxError` / `isActiveScript` accept
both, and `sieve.test.ts` pins that.

**The active script cannot be deleted**, and that refusal is worth keeping
apart from every other failure: "switch it off first" is something the user can
act on, where the server's sentence only explains why it said no. The service
reports it as the `active` blocker, the same shape `mailboxes.ts` uses for
`mailboxHasChild`.

**Deactivating does not change the account's state string.** Sending
`onSuccessDeactivateScript` alone came back with `oldState` equal to
`newState`, even though the script really was deactivated (the destroy that
followed succeeded, which it could not have otherwise). Nothing here depends on
that, because every write is followed by a fresh `SieveScript/get` — but a
future delta sync keyed on the state would silently miss the change.

**Validation errors name the line and usually the column** ("Expected token
\"string\" but found \"{\" at line 1, column 30."), which is why the message is
passed through verbatim rather than replaced with wording of our own.

Stalwart's account capability also carries the real limits — `maxSizeScript`
102400, `maxNumberScripts` 100, `maxSizeScriptName` 512 — and a long
`sieveExtensions` list. None of it is read yet; a script that breaks a limit
comes back as a refusal like any other.

## Testing

`e2e/sieve.spec.ts` drives the whole flow against Stalwart: a script the server
rejects (asserting the error names a line), the same script fixed, save and
activate, reopen to prove the text comes back from the *server* rather than
from the editor's own state, the refusal to delete while active, then
deactivate and delete.

`e2e/global-setup.ts` deactivates and purges scripts as part of the reset. That
matters more here than for other leftovers: an active script left behind by a
failed run actually filters mail in the account every other spec reads, so a
stray `fileinto` would surface as a pile of unrelated mail failures.
