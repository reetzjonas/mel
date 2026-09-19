# Hard-won gotchas: calendar / iTIP scheduling (do not rediscover)

- **A leap-day birthday needs a leap-year anchor.** Birthdays are derived into
  the calendar as ordinary yearly events (`features/calendar/birthdays.ts`) and
  expanded by the same `expandAll` as real ones. Anchoring one in the year
  before the window is what keeps the expansion short — but "2025-02-29" is not
  a date, and it rolls forward to 1 March, putting the series on the wrong day
  every year after. The anchor walks back to a real leap year, from which a
  yearly rule recurs only in leap years, which is the honest answer for a
  29 February birthday.

- Stalwart calendar: `recurrenceRule` is **singular** (not `recurrenceRules`);
  ContactCards are **flat** JSContact objects (no `card` wrapper).

- **`recurrenceOverrides`, as Stalwart actually behaves** (probed against 0.16
  before any of it was written; see `recurring-events.md` for the design):
  - It **stamps `updated` into every patch it stores**. A client that models a
    patch as a fixed set of fields and writes the whole map back deletes that
    stamp — and anything another client wrote — which is why mel keeps each
    patch as an open map.
  - `recurrenceOverrides/<recurrenceId>` as a **whole-object pointer works**,
    but a deeper pointer (`…/<recurrenceId>/title`) only works when that
    override **already exists**; otherwise the whole `/set` fails with
    `invalidProperties`, "Patch operation failed".
  - `recurrenceOverrides: null` **clears them**, and a cleared event simply
    omits the property on read. Leaving the property *out* of an update keeps
    whatever the server has — so an occurrence being put back into the series
    has to send the map explicitly, null included.
  - A recurrence id the rule never produces is **kept** (RFC 8984 says it adds
    an occurrence); a malformed one (`"nonsense"`) is **silently dropped**.
- **Scheduling/iTIP has three traps, all silent** (worked out the hard way, see
  `providers/jmap/calendars.ts`):
  1. `CalendarEvent/set` needs the argument **`sendSchedulingMessages: true`**.
     Without it the event including its participants is stored but **no invitation is
     sent** — no error, no warning.
  2. Stalwart names participants by **`calendarAddress: "mailto:…"`** (the newer
     JSCalendar draft), *not* `sendTo`/`email`/`replyTo` as in RFC 8984. Send the
     RFC 8984 shape and it lands as an opaque `JSPROP` fallback in the iCalendar,
     **no ATTENDEE lines** are produced, `/get` does not return `participants` at all
     — and again: no error.
  3. `roles: {owner: true}` alone is not enough: **without
     `organizerCalendarAddress` Stalwart writes no ORGANIZER** and sends nothing. The
     price is that the server mirrors the organiser back as a second, roleless
     participant entry — `toParticipants` folds that back together by address and
     keeps the entry *with* roles (only its key works for RSVP patches).
  Roles are `owner`/`chair`/`required`/`optional`. RSVP is a patch on
  `participants/<id>/participationStatus` (a patch trying to create a *whole* new
  participant fails with `invalidPatch`).
  Debugging trick: read the raw iCalendar over CalDAV (`PROPFIND`/`GET` on
  `/dav/cal/<user>/default/…`) — that shows immediately whether ATTENDEE/ORGANIZER
  were really written or only `JSPROP` lines.
- Server settings for it: `x:CalendarScheduling` (`enable`, `autoAddInvitations`,
  HTTP RSVP) — `enable` is already on in the dev Stalwart, nothing to do.
- Calendar only works against Stalwart (Fastmail has no standard JMAP calendar);
  capability gating is in place in the AppShell.
- **`new Date()` as an anchor/grid date carries the current time along** — used
  directly as a sync window boundary (`grid[0]`/`grid[last]`) it shifts the window
  after midday to "now until tomorrow-now" instead of midnight to midnight, dropping
  earlier events. Always normalise to midnight before using date objects as window
  boundaries (see `byDay` in `calendar.tsx`).
- e2e: desktop and mobile share one server account → state-mutating specs are desktop
  only (`testIgnore`); tests must clean up their server-side artifacts or use random
  names/days (calendar cells cap at 3 chips).
- **Clearing a field needs an explicit `null` on update.** `fromEvent` leaves an
  empty location, description or meeting link out (a create must not send
  nulls), and an absent key in `CalendarEvent/set` update **keeps what the
  server has** — so an emptied field used to come back on the next sync.
  `updateEvent` therefore sets `locations`, `description` and `virtualLocations`
  to `null` when they are empty. `meetingUrl` is optional on the type and is only
  cleared when it is `''` (known empty); `undefined` means the row was synced
  before the link was read, and there an empty dialog field must not wipe the
  server's value. Stalwart accepts `virtualLocations` as
  `{v0: {"@type": "VirtualLocation", uri}}` and `null` clears it (checked by
  `e2e/calendar.spec.ts`, "a meeting link and a map link…"). Like `locations`,
  only the first entry is read and `v0` is written, so a second virtual location
  from another client is replaced on save.
- **Meeting and map links are an allow-listed `href`.** An event arrives from
  someone else's invitation, so the join link goes through `webHref`
  (`lib/links.ts`: http/https only, a bare host becomes https) — a `javascript:`
  URL in `virtualLocations` is shown as nothing, not as a link. The map link is
  the same OpenStreetMap search the contact card uses (`mapHref`); structured
  `coordinates` are not read yet.
- **`freeBusyStatus`, `privacy` and `categories`** (issue #67) follow the same
  rules as the meeting link: optional on `CalendarEvent`, read as their RFC 8984
  defaults (busy / public / none), left off the wire at those defaults on create,
  and sent as `null` on update once known to be at the default — while a row that
  never read them (`undefined`) stays untouched by a save whose controls are
  still at rest. `categories` is a `String[Boolean]` map on the wire and a plain
  list in the domain. Stalwart round-trips all three (`e2e/calendar.spec.ts`,
  "free/busy, visibility and categories…"). Nothing reads them yet: mel neither
  hides a `private` event from a sharee nor treats a `free` one as non-blocking,
  because it has no free/busy view — they are stored and edited, that is all.
- **Managing calendars** (issue #6, `services/calendars.ts`,
  `CalendarDialog.tsx`; server-first like folders, no outbox). Probed against
  Stalwart 0.16:
  - A calendar created without `isSubscribed: true` comes back **unsubscribed**,
    so `editCalendar` always sends it.
  - `isDefault` is **read-only** (`invalidProperties` on create/update). The
    first calendar an account has becomes the default by itself.
  - **Stalwart lets you destroy the default calendar**, and then the account has
    none — no event can be created until another exists. The dialog therefore
    disables Delete on `isDefault`; the server would not stop it.
  - Destroying a non-empty calendar fails with `calendarHasEvent` unless
    `onDestroyRemoveEvents: true`, in which case its events go with it. The
    dialog asks first, then asks again with the events named.
  - Creation is gated by `mayCreateCalendar` in the account capability, read as
    `capabilities.calendarCreate` — an explicit `false` hides the "+" button,
    a missing flag does not (the server is asked and refuses if it must). A
    stored account from before the flag existed has it `undefined`, which the
    UI treats as allowed.
  - The sidebar (and so this whole feature) is desktop-only, like the
    visibility toggles: below `lg` there is no sidebar.
