# Filter rules (JMAP Sieve)

Server-side mail filtering, as a section in Settings → Mail, gated on
`urn:ietf:params:jmap:sieve` (RFC 9661). Rules run on the server, so they apply
on every device and to mail arriving while mel is closed — which is the reason
to offer this at all rather than filtering locally.

There are two ways in, and which one you get is a fact about the script rather
than a preference: a **guided form** for rules the form itself wrote, and the
**script editor** for everything else. Most people will never write Sieve by
hand, so the form is what a new rule set opens on; the text editor stays
because Sieve is a real language and the form covers a deliberately small part
of it.

## From a message to a rule

The reading pane carries "Filter messages like this", which is where most
rules will actually start: you are looking at the mail that prompted it. It
hands the sender to the form through the UI store — a one-shot handover
between two screens, like the composer's init, rather than something anyone
should be able to bookmark — and settings opens with a rule already matching
that sender.

The form reads the seed as its **initial state**, not from an effect: the
dialog mounts fresh each time it opens, so the seed is the first render's own
input, and an effect would spend a render showing an empty form first (the
trap `#50` is about).

**No destination folder is guessed.** Filing into whichever folder happens to
sort first is a decision about someone's mail that we have no basis for, so
the folder select starts on "—". That makes an unfinished rule possible, so
two things back it up: `toSieveScript` leaves out a `fileinto` with no folder
(and skips the rule entirely if that was its only action, rather than emitting
`fileinto ""`), and saving is refused with `unfinishedRules` naming the
problem. Without the second half the first would be worse than the bug —
"saved" for a rule that quietly does not exist.

## How the form round-trips

A form cannot parse arbitrary Sieve, and pretending otherwise would mean
silently rewriting a script someone tuned by hand. So `lib/sieveScript.ts`
writes the rules it generated onto a marker line —

```
# mel-rules:v1 [{"name":"Newsletters", …}]
```

— and reading them back only ever trusts that line. A script without it, or
with a damaged one, is reported as hand-written and offered as text with a
sentence saying why.

Two consequences worth keeping:

**Saving from the text editor strips the marker** (`stripRuleMarker`). Without
that, a hand-edited body would still carry the rules as they were *before* the
edit: reopening would show the form's version and saving from the form would
throw the hand-written changes away without a word. Losing the marker is much
the cheaper half of that trade.

**"Edit as text" is one-way** within an editing session, for the same reason.
Going back would read rules off a marker that no longer describes what is in
the box.

The generator escapes into Sieve strings (`\` and `"`); a subject containing a
quote would otherwise close the string and turn the rest of the rule into
syntax — and `require` lists only the extensions the chosen actions actually
use, since requiring one the server lacks fails the whole script. Every shape
the form can produce was validated against Stalwart, and `e2e/sieve.spec.ts`
keeps that honest by building a rule whose value contains quotes and asking
the server.

## Shape

| Layer | Where |
| --- | --- |
| Domain objects (script, rule) | `src/domain/sieve.ts` |
| Rule → Sieve, and back | `src/lib/sieveScript.ts` |
| JMAP provider | `src/providers/jmap/sieve.ts` |
| Writes | `src/services/sieve.ts` |
| UI | `src/features/settings/SieveSetting.tsx` + `RuleWizard.tsx`, in the Mail tab |

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

`e2e/sieve.spec.ts` covers three paths against Stalwart:

- **The form.** A rule whose value contains quotes, checked by the server,
  saved, then reopened to prove the value survives the round trip — and the
  generated script shown as text.
- **A hand-written script.** Saved from the text editor, it must come back as
  text with the "not written by the form" line, never in the form.
- **The script editor.** A script the server rejects (the error has to name a
  line), the same script fixed, save and activate, reopen to prove the text
  comes back from the *server* rather than from the editor's own state, the
  refusal to delete while active, then deactivate and delete.

Its selectors are scoped to the filter rules `section`: the Mail tab also
carries the vacation response, which has a `Save` button of its own.

`e2e/global-setup.ts` deactivates and purges scripts as part of the reset. That
matters more here than for other leftovers: an active script left behind by a
failed run actually filters mail in the account every other spec reads, so a
stray `fileinto` would surface as a pile of unrelated mail failures.
