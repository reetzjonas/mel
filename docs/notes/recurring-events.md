# Editing one occurrence of a series

A weekly meeting that moves once is the ordinary case, and until this existed
mel had no way to say it: the drag code refused every event with a
`recurrenceRule` outright, because moving one instance would have moved all of
them. Issue #5.

RFC 8984 keeps the answer in `recurrenceOverrides`: a map from an occurrence's
**original** local start to a patch of what differs, where `excluded: true`
means it does not happen at all. The id stays the original start even after the
occurrence has been moved elsewhere — it identifies which occurrence, not when
it is.

| Layer | Where |
| --- | --- |
| The patch format | `src/lib/occurrence.ts` |
| Expansion | `src/lib/recurrence.ts` (`expandOccurrences`) |
| Wire | `src/providers/jmap/calendars.ts` (`toOverrides`, `fromEvent`) |
| The question | `src/features/calendar/ScopeDialog.tsx`, applied in `routes/calendar.tsx` |

## A patch is an open map, not a typed object

`RecurrencePatch` is `Record<string, unknown>` while `RecurrenceRule` right
above it in `domain/calendar.ts` is a careful subset — the difference is
deliberate. A patch's keys are JSON pointers into the event
(`locations/l0/name`), servers add their own (Stalwart stamps `updated` into
every patch it stores), and mel rewrites the whole map whenever it saves an
event. A typed shape would quietly delete whatever another client put there.

Reading is still done field by field with the types checked, because a patch
arrives off the wire: a number where a title belongs is ignored rather than put
into the event.

`patchFor()` writes only what actually differs from the series. A patch that
repeats the series' own title is a title the series can no longer change, which
is not what "move this one meeting" was meant to say.

## Expansion looks at every override, whatever the window

The rule is expanded for the window on screen, but the overrides are walked in
full and only then filtered by the window. Two cases need that:

- an occurrence **moved into view** from a date outside the window the rule is
  expanded for — its recurrence id is in May while the screen shows April;
- an override whose recurrence id the rule **never produces**, which RFC 8984
  says adds an occurrence. Stalwart keeps those, so skipping them would hide an
  event mel simply did not create itself.

An occurrence whose id is in the map is taken out of the rule's own results and
added back from its patch, so nothing appears twice.

## "This one, or all of them?"

Asked **after** the edit is worked out, never before: the drag finishes
normally, and the dialog then decides where the result is written. Cancelling
leaves the event untouched. Both answers are buttons — neither is the safe
default, since a series moved when only today's meeting shifted is exactly as
annoying to undo as the reverse.

Two things make the question moot, and are applied to the series without
asking, because "this occurrence" cannot express them at all:

- changing the **repeat** (a rule belongs to the series), and
- changing the **calendar** (an occurrence does not have one of its own).

The dialog says so under the repeat picker while it is editing an occurrence,
rather than surprising anyone afterwards.

**"All events" moves the series by the days the occurrence moved** rather than
writing the occurrence's own date as the series start, which would drop every
earlier occurrence. It also rewrites a single-day `byDay` to the new weekday —
without that, dragging a Monday standup to Wednesday and choosing "all events"
would appear to do nothing, since the rule would go on producing Mondays.

**"All events" drops that occurrence's own patch**, or the patch would go on
overriding the very change that was just asked for everywhere. Other
occurrences' patches stay.

## Everything is one write of the whole event

There is no new outbox action: an override rides inside the event, so
`services/calendar.ts` `updateEvent` already carries it, the local mirror
updates optimistically, and undo is the event as it was — exact, rather than an
inverse somebody has to keep correct. Deleting one occurrence is the same write
with `excluded: true`; deleting the series is the existing destroy.

`MODEL_VERSION.CalendarEvent` is 2, so cached events from before this refetch
instead of appearing to have no overrides (the trap written up at the top of
`gotchas-jmap-mail.md`).

## Where it stops

- **Participants are series-wide.** An occurrence patch mel writes never
  contains participants, so invitations and RSVPs stay on the series. An
  attendee list that differs for one occurrence is possible in RFC 8984 and is
  not offered here.
- **Invitation copies still cannot be dragged at all** — someone else's event
  to move — and birthdays have no event behind them to write to.
- The **e2e proof** is `e2e/calendar.spec.ts`: one occurrence moved an hour and
  the next week's occurrence still where it was, after a reload; and a whole
  series dragged onto another weekday, which is the case that needs the `byDay`
  rewrite.
