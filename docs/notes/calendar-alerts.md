# Calendar reminders (issue #4)

An event can carry a reminder — "15 minutes before" — and mel shows it while it
is running. This note is about what that promises, and what it cannot.

## What is stored

JSCalendar `alerts` (RFC 8984 §4.5.2), on the event, so every client of the
account sees the same reminder and Stalwart round-trips it (checked against
0.16: an `OffsetTrigger` with `relativeTo: start` and `action: display` comes
back as written).

`CalendarEvent.alerts` is an **open map**, like `recurrenceOverrides`, and for
the same reason: mel rewrites the whole map on every save, so an email alert,
an absolute trigger or a field another client added survives only if nothing is
dropped on the way in. The dialog manages exactly one alert — a display alert
some whole minutes before the start — under the key it found it at
(`mel-reminder` for one it creates), and leaves the rest alone
(`lib/alerts.ts`: `reminderOf`, `withReminder`). A value another client set
that is not among the presets is offered as "Custom: N min", so opening and
saving such an event does not silently change it.

**`alerts` is optional on the type.** Rows synced before alerts were read have
none, and a delta sync does not rewrite an event that did not change. `fromEvent`
therefore sends `alerts: null` only for a _known_ empty map; `undefined` is
omitted. The other way round, opening an old event and saving it would have
deleted reminders set elsewhere.

Not offered, not edited, but **shown if present**: an alert relative to the end,
an absolute trigger, an offset after the start. `action: email` is the server's
to send and mel ignores it.

## When one is due

`pendingAlerts` expands the occurrences (the same expansion the grid uses) and
puts each alert at its moment:

- The offset is added to a **zoned** time in the event's own zone. "A day
  before" is the same wall-clock hour yesterday, not 24 hours — different on the
  day the clocks change. A series keeps its hour across DST for the same reason
  the grid does.
- An **all-day** event is anchored in the viewer's zone (it has no zone of its
  own).
- A moved occurrence (`recurrenceOverrides`) fires at its new time, and an
  excluded one not at all.
- `acknowledged` (another client showed and dismissed it) is honoured, but only
  if it is not older than the alert it would be about.

The key of a shown alert contains the moment it fell due, so **moving the event
makes a new alert** — it is shown again for the new time.

## What a closed browser does (nothing)

There is no server of ours to wake a device, and the API made for this
(notification triggers / `showTrigger`) was withdrawn from Chromium. Web Push
(`docs/notes/push-notifications.md`) is driven by the JMAP server, which does
not know about alerts. So a reminder is shown by a page that is open: the tab or
the installed PWA, in the background is fine.

What softens that is the **catch-up**: an alert whose moment passed while the
app was closed, the laptop asleep or the network gone is shown when mel next
runs, **as long as the event has not ended**. "Not ended" rather than "not
started" is deliberate — a meeting that started five minutes ago is still worth
knowing about, one that is over is not a reminder.

Do not promise more than this in the UI. If closed-app delivery is ever wanted,
the honest routes are the server sending the alert as email (`action: email`,
which Stalwart does) or a Web Push sender that knows the calendar — both are
server-side work.

## Where it runs

`services/eventReminders.ts`, started from `AppShell` beside the sync
scheduler — but it holds no connection, so it _stops_ on an account change or a
lock rather than being left running. It reads events through `liveQuery`, so
edits and syncs replan at once. Decrypted events are needed, which is why this
lives in the main thread and not the service worker (same limit as
`push-notifications.md`).

- **Timer:** one `setTimeout` to the next alert, never longer than 15 minutes
  (a timer does not count time the machine spent asleep), and a replan when the
  tab comes back to the front.
- **What was shown** is remembered in `localStorage` (`mel:reminded:<account>`,
  keys → due-time, pruned after two days). Ids and timestamps only, so nothing
  to encrypt; the worst a cleared store does is show a reminder twice.
- **How it is shown:** a system notification through the service worker's
  registration when permission is granted (Android Chrome refuses
  `new Notification`; the constructor is only the fallback), otherwise a
  snackbar in the page. With no permission _and_ the page hidden, nothing is
  marked shown, so it appears when the tab returns.
- **Permission** is asked for at the moment someone picks a reminder in the
  dialog, which is the one time the prompt is not a surprise.
- More than five due at once is a backlog after a long absence; five are shown.
- A calendar hidden in the sidebar does not remind.
- A notification's `data.url` decides where a click leads (`/calendar`); the SW
  falls back to `/mail` for new-mail notifications, which never carried one.

## Known gaps

- **One occurrence of a series has no reminder of its own.** The dialog hides
  the field while editing "this one", because a patch for one occurrence does
  not carry `alerts` and a change would be lost.
- A declined invitation still reminds if the server's copy has an alert.
- Notes' due dates (#88) are meant to reuse this plumbing.

## Testing

Headless Chromium answers the notification permission with "denied" and ignores
`grantPermissions`, so the end-to-end test (`calendar.spec.ts`, "a reminder is
stored…") covers the in-page path and the round trip through the dialog. The
system-notification path is unit-tested (`eventReminders.test.ts`), with a
mocked registration.
