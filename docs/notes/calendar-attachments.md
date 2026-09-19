# Event attachments (JSCalendar `links`)

Issue #66. An event carries attachments as entries of its `links` map whose
`rel` is `enclosure` (RFC 8984 §4.2.7). `CalendarEvent.links` is kept as an
**open map**, like `alerts` and `recurrenceOverrides`: mel edits the
attachments and rewrites the whole map on every save, so a link that is not an
attachment, or a field another client put on one, has to survive. It is
optional on the type for the same reason as `alerts` — a row synced before
links were read has none, and "unknown" must never be written back as "cleared"
(`fromEvent` sends `null` only for a *known* empty map).

| Layer | Where |
| --- | --- |
| Reading and building links | `src/lib/attachments.ts` |
| Device upload, Files reference, saving | `src/services/eventAttachments.ts` |
| The list and the buttons | `src/features/calendar/EventAttachments.tsx` |
| Choosing a file in Files | `src/features/files/FilePicker.tsx` |

## What Stalwart does with a link (probed against 0.16)

| Sent | Result |
| --- | --- |
| `href` (https) | stored, read back unchanged |
| `blobId` **only** | **silently dropped** — `links` comes back `null` |
| `blobId` + `href` | both kept; `href` is not rewritten |
| `href` as a `data:` URI, 100 KB / 1 MB / 4 MB | stored as given |

So the mail way — upload a blob, keep its id — does not work here: without an
`href` the whole link vanishes with no error. Anything with a `blobId` has to
carry an `href` too.

## Three kinds of attachment

- **Embedded** (a file from the device): `href` is a `data:` URI with the bytes.
  It travels with the invitation, so an attendee on another server receives it,
  and it opens with no request. The price is that every byte rides along in each
  sync of the event and sits in IndexedDB, so it stops at `MAX_EMBEDDED_BYTES`
  (1 MB); anything bigger is pointed at Files.
- **File reference** (from Files): `blobId` plus `href` = the blob's download
  URL, and the name, type and size. Free to sync. Only mel on that account can
  open it (through its authenticated download, not the anchor), and **editing
  the file in Files gives it a new blob id, which leaves the link dead** — the
  dialog says so ("may have been changed or deleted") instead of failing quietly.
- **Web**: a plain `http(s)` link another client attached; shown as a real
  anchor.

`attachmentsOf` is an allow list: `javascript:`, `ftp:` and the like are not
offered, since the value is somebody else's data on its way into an `href`.

## Not done

- One occurrence of a series has no attachments of its own: the section is
  hidden while editing "this one", because an occurrence patch does not carry
  `links` and a change would be lost (the same rule as reminders).
- Nothing follows a Files file across an edit; a reference is to a blob, not a
  node. Storing the node id would need a convention no other client shares.
