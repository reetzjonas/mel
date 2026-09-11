# Hard-won gotchas: calendar / iTIP scheduling (do not rediscover)

- Stalwart calendar: `recurrenceRule` is **singular** (not `recurrenceRules`);
  ContactCards are **flat** JSContact objects (no `card` wrapper).
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
