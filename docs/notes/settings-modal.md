# Settings as a modal

Settings used to be `/settings`, a screen of its own reached from the gear, the
sync bar and the two "this server cannot do that" hints. Eleven `Section` blocks
sat in one column, which read as a list to scroll rather than a place to find
something.

They are a dialog now, opened over whatever the user was looking at, with the
sections grouped into five tabs:

| Tab | Contents |
| --- | --- |
| General | language, theme |
| Mail | conversation view, remote images, vacation response |
| Notifications | notification permission, Web Push |
| Security | encryption at rest |
| Account | account, resync, queued changes, server features, sign out |

## Why the URL still carries it

The open tab is a search param (`?settings=<tab>`) validated on the **root**
route, not component state, because three things depend on an address:
bookmarks, the back button, and the sync bar — which exists to answer "why is
the calendar missing", so it has to be able to point at the capability list.
`/settings` survives as a route whose only job is to redirect to
`/mail?settings=general`.

Two consequences worth knowing:

- Switching tabs navigates with `replace`, so closing the dialog is one press of
  Back however long someone browsed around inside it.
- `/mail`'s inbox auto-redirect had to start carrying the search along
  (`search: (prev) => prev`). Without it a deep link to `/settings` opened the
  dialog and then lost it again the moment the mailboxes arrived.

## Fixed frame, landscape

The panel does not size itself to its contents: the tabs differ far too much in
length (two selects on General, queue plus the whole capability list on
Account), and a panel that resizes on every tab click reads as hectic — the
same reasoning as the height-neutral hover swap in the folder list. Desktop is
`min(85vh, 38rem)` tall by `max-w-4xl`, so roughly 880×600, wider than it is
tall. `e2e/navigation.spec.ts` measures the panel on every tab and fails if one
differs.

That width is why the tabs sit in a rail down the left on `sm:` and up: with
them on top, the width would only go into stretching every select across the
panel. Beside the content it goes into what can use it — the capability list,
the queue, the vacation text. The selects are capped at `sm:max-w-sm` for the
same reason, while the hints below them keep the full measure.

## Tabs that would open onto nothing

Encryption and everything under Account need an account, so those two tabs are
hidden without one. The account arrives a tick after the dialog does, so the
tab list assumes an account exists until the query says otherwise — correcting
the URL on the empty first render would rewrite a deep link to the first tab
before the data had a chance to disagree.

## What this flushed out

Keeping the mail list mounted behind the dialog exposed a real bug that the old
route had been hiding: enabling encryption aborted, because the list's
`updating` table hook calls `openEnvelope` on rows the crypto middleware has not
decrypted, and throwing inside `rewriteAccountRows`' transaction rolled the
whole migration back. Details in `gotchas-dexie-performance.md`.
