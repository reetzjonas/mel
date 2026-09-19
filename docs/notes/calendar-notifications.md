# Calendar notifications (CalendarEventNotification)

Issue #3. Other people's changes to events we are part of — an attendee
accepting, someone moving the time, a cancellation — are separate objects on
the server, not just a changed event. mel syncs them like any collection
(`db.eventNotifications`, state key `CalendarEventNotification`, cleared on
sign-out with the rest) and shows them behind the bell in the calendar toolbar.

| Layer                 | Where                                                             |
| --------------------- | ----------------------------------------------------------------- |
| Wire → domain, `kind` | `toNotification` in `src/providers/jmap/calendars.ts`             |
| Sync + dismiss        | `syncEventNotifications`, `dismissEventNotifications` (same file) |
| Local mirror          | Dexie v9, `eventNotifications`; wired in `sync/engine.ts`         |
| Dismiss               | `src/services/eventNotifications.ts`                              |
| Text                  | `features/calendar/notificationText.ts`, `tf()` in `lib/i18n.ts`  |
| UI                    | `NotificationsDialog.tsx`, the bell in `routes/calendar.tsx`      |

## What Stalwart sends (0.16)

- A **plain `get` returns only `id`, `created`, `changedBy` and `type`.**
  `calendarEventId`, `eventPatch` (and `comment`) come back only when named in
  `properties`, so the provider always asks for them. `event` was never returned.
- Only `type: "updated"` was seen, all caused by an attendee's reply. `created`
  and `destroyed` are handled as the draft describes them, but have not been
  observed against this server.
- **An RSVP is a plain `updated`.** `eventPatch` is not a diff: it holds the
  whole participant map as it now stands, and nothing says _what_ changed. The
  sender is named in `changedBy`, so their own entry in that map is the answer —
  if it says accepted / declined / tentative, that is what they did (`kind`);
  otherwise it is a plain "changed". Looking at _everyone's_ answers instead
  would report an old acceptance every time somebody moved the time.
- `CalendarEventNotification/set` with `destroy` dismisses one, for every client.
  There is no "read" flag: a notification is either there or dismissed, which is
  why dismissing is an explicit click and opening one does not do it.

## Choices

- **Dismissal is server-first**, and the local row stays until the server
  agrees — a dismissal is shared, so pretending it worked offline would bring
  the notification back on the next sync.
- **A server without the method** (`unknownMethod`) reports an empty, settled
  collection instead of failing, so calendar sync carries on.
- Sentences have word order that differs by language, so they are templates
  (`{name}`, `{title}`) filled by `tf()` rather than fragments glued together.
- The event's _current_ title wins over the one the notification carried; the
  notification's own is the fallback when the event is gone.
- **`CalendarEvent`'s `MODEL_VERSION` went to 3** in the same change: the
  meeting link, free/busy, privacy, categories and attachments are new fields on
  the mapper, and a cached row never gains one by delta sync. This is why those
  fields are optional on the type but no longer stay "unknown" for long.

## Not done

- No system notification or unread badge outside the calendar: the count lives
  on the bell. Web Push for these would need the sender's request (see
  `push-notifications.md`).
- Nothing is dismissed automatically when the event is opened.
