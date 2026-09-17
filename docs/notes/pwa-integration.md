# PWA integration: how the rest of the system reaches mel

Everything an installed mel offers the operating system, and the two places
that answer it: the manifest in `vite.config.ts` and the `/compose` route.

## `/compose` is an entry point, not a screen

`src/app/routes/compose.tsx` opens the composer the shell already mounts, then
replaces itself with `/mail`. It renders nothing.

`replace` rather than a push, deliberately. The handover URL carries an address,
a subject and a body; the composer's own state is kept out of the URL
everywhere else in the app for exactly that reason, and Back should return to
whatever the user was doing, not re-open a half-written message.

Two shapes arrive here:

- `?mailto=<the whole mailto: URL>` — the OS protocol handler, which substitutes
  the link into `%s`.
- `?subject=&body=&url=` — the share target, whose manifest `params` map the
  shared title, text and link onto those names. Plenty of apps send both a
  blurb and a link, so the two are joined rather than one winning.

## Why `mailto:` is parsed by hand

`src/lib/mailto.ts`, not `new URL()` + `URLSearchParams`.

RFC 6068 percent-encodes the query. `URLSearchParams` applies *form* encoding
rules, where `+` means a space — so `mailto:?to=erika+news@example.com`, an
ordinary plus-addressed recipient, would arrive as `erika news@example.com` and
never send. Splitting on `,` also happens *before* decoding, so a
percent-encoded comma stays inside the address it belongs to instead of tearing
it in two.

## The icon badge

`src/lib/appBadge.ts` wraps the Badging API; `src/features/mail/appBadge.ts`
keeps it on the inbox's unread count.

- **The inbox only.** A badge that counts every folder never goes out for
  anyone who keeps an archive full of unread mail, and a permanent badge is one
  people stop reading.
- **From the app: the real count. From a push: a bare flag.** A StateChange
  says only that mail changed, and the stored count is whatever the last sync
  saw — any number the service worker put up would be a guess. The app replaces
  the flag with the real figure the moment it is opened.
- Signing out clears it: the badge outlives the tab, so a count left behind
  would point at mail this device no longer has.

Firefox and iOS Safari have no Badging API, and browsers that do still reject
while mel is an ordinary tab rather than an installed app. Both are ignored
rather than reported — a badge is an extra, never something the app leans on.

## Sharing out

`src/lib/webShare.ts`, used by the file preview. `shareFile` reports back
whether the file reached the share sheet, and the preview saves it instead when
it did not, so the button always does something. A dismissed sheet counts as
handled: the person was shown the choice and made it, and dropping a download
on them afterwards is not what they asked for.

Sharing a contact or an event is not offered, because neither has a file to
share yet — that needs vCard export (#7) and an iCalendar *writer*
(`src/lib/icalendar.ts` reads only, for iMIP invitations).

## Why there are no `file_handlers`

Registering for `.eml`, `.ics` and `.vcf` (#80) is one manifest entry, but
double-clicking such a file would then open mel and do nothing: importing them
needs `Email/import` (#72), a vCard reader (#7) and an iCalendar reader beyond
the invitation-shaped subset that exists. Claiming the file type before the
handling exists is worse for the user than not claiming it.

## Manifest labels are English

A manifest is one static file written at build time. It has nowhere to carry
the translations `src/lib/i18n.ts` picks between at runtime, and the format has
no localization of its own, so the shortcut names stay English.

## Manifest images: bitmaps, at the size they claim

Chrome's DevTools reported `favicon.svg` as "failed to load" on every visit,
while the file itself served fine (200, `image/svg+xml`). Manifest icons are
fetched and decoded without a renderer behind them, and that decoder does not
do SVG — so a manifest may only point at bitmaps, however scalable the artwork
is. The tab icon in `index.html` is still the SVG; that one is a document
resource and every browser rasterizes it.

The same applies to the shortcut icons, which additionally have to declare
96×96 — the size a launcher draws them at. `scripts/shortcut-icons.mjs` draws
the app's own glyphs on the brand violet and rasterizes them through the
Chromium that Playwright already brings, rather than adding a native image
library for three files under 3 KB.

`screenshots` are what a browser shows in its install dialog, and it wants one
per form factor: without a `wide` one the desktop dialog stays plain, and
without a non-`wide` one the mobile dialog does. They are taken by
`scripts/screenshot-readme.mjs` in the same run as the README's, against the
same demo data, and land in `public/screenshots/`. They stay out of the service
worker's precache (its glob only reaches the top level) — an install dialog is
not something to have offline, and they are two thirds of the static payload.

A `share_target` with `method: 'GET'` is only allowed one encoding, and it is
the default — which is exactly why it is written out: a target that leaves it
unstated is flagged for relying on a default rather than choosing it.

All of this is checkable without opening DevTools: Chrome answers
`Page.getAppManifest` over CDP with the same list of complaints.
