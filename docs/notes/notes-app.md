# Notes (a fifth app, built out of files)

Keep-style notes: text, checklists, pictures, pinned or not. Issue #86, with
the offline half from #87.

JMAP has no working task or note capability — `draft-ietf-jmap-tasks` is
expired and nothing implements it — so notes ride on the storage mel already
has, JMAP FileNode. The Notes tab answers to the same capability the Files tab
does: no file storage, nowhere to keep a note.

| Layer | Where |
| --- | --- |
| Domain object | `src/domain/note.ts` |
| The file format | `src/lib/noteFile.ts` |
| Read model | `db.notes`, filled by `src/sync/notes.ts` |
| Writes | `src/services/notes.ts` (local) + `src/sync/noteWriter.ts` (server) |
| Editor | `src/features/notes/MarkdownEditor.tsx` + `liveMarkdown.ts` (CodeMirror) |
| UI | `src/features/notes/`, routes `notes.tsx` / `notes.index.tsx` / `notes.$noteId.tsx` |

## A note is a Markdown file, not a blob mel invented

```
Notes/einkauf-4f2a/note.md
Notes/einkauf-4f2a/zettel.png
```

```markdown
---
id: a8419dc6-fb73-493c-bd35-f6cff33bb0dc
title: Einkauf
pinned: true
---

- [ ] Milch
- [ ] Brot

![zettel.png](zettel.png)
```

The original plan in #86 was one JSON file per note under a vendor media type.
That would have made notes the **first thing in mel that only mel can read** —
everything else in the app is somebody else's standard (JMAP mail, JSContact,
JSCalendar, FileNode) — and it would have cost nothing to avoid. Markdown says
all of it: a checklist is `- [ ] milk`, which every editor and forge already
renders; the three things Markdown has no place for sit in a front matter
block; and the note is readable over WebDAV, in another client, or in mel's own
Files app.

Front matter is conventionally YAML, and this parser is not one: a note needs
`key: value` on one line, and pulling in a YAML library to read five scalars
would be the biggest thing in the bundle for the least reason. Keys it does not
know are **kept and written back** — the same rule as the calendar's recurrence
patches, for the same reason: mel rewrites the whole file when it saves.

Anything that is not a note is left alone. A folder in `Notes/` without a
`note.md` is not shown as an empty note, and a `.md` file that some other tool
wrote is read as a note with no front matter, titled by its first line, rather
than refused.

## Why images are separate files

This is what decided the shape. The plan said one file per note, which leaves
only base64 inside the document, and that goes wrong three ways: the list
fetches every note's text, so a 4 MB photo becomes 5.3 MB of base64 travelling
on every read; correcting a typo re-uploads the picture; and IndexedDB then
holds the decoded copy as well. A picture belongs beside the note, which is why
a note is a **folder**:

- the reference is a relative file name (`![](zettel.png)`), resolved against
  the note's own folder — no ids to break when another client renames something;
- deleting a note is deleting its folder, pictures included;
- an image is uploaded through the same endpoint as any other file
  (`maxSizeUpload` is 50 MB on the dev server, against 7.1 MB for `Blob/set`),
  so a phone photo is an ordinary case;
- and sharing a note later (#89) is sharing a folder, which is what FileNode
  sharing is about anyway.

Each picture hangs under the line that refers to it, in the editor itself.

## The editor: a live view, not a converter

The first version was a plain textarea with the Markdown showing, and a list of
thumbnails under it. It was rejected on sight, and fairly: `**nicht**` in the
middle of a sentence is not what anyone means by a note.

What replaced it is the Obsidian arrangement, in CodeMirror 6 — which is what
Obsidian itself uses. The buffer **is** the file, byte for byte; the formatting
is drawn over it as decorations (`liveMarkdown.ts`):

- markup characters are hidden — `**bold**` reads as bold — and come **back on
  whichever line the cursor is in**, because that is the line being edited;
- `- [ ]` is replaced by a real checkbox that ticks, cursor or not, since it is
  the one piece of markup that is also a control;
- an image reference grows the picture underneath it;
- the hidden ranges are `atomicRanges`, so an arrow key steps over a `**`
  rather than parking the caret inside characters nobody can see.

**The alternative was a rich-text editor** (Tiptap is already in the app), and
it was the wrong one. A WYSIWYG has to parse Markdown into a document and write
it back out on every save, and the first note written by another tool with
syntax mel does not model would come back mangled. The whole design rests on
the file being an ordinary Markdown document that other things can write too,
and a converter quietly undermines exactly that. Decorations cannot: they
change nothing.

Two things to know when touching it:

**Block widgets must come from a `StateField`, not a `ViewPlugin`** — the
picture under a line is one, and CodeMirror refuses it from a plugin with
"Block decorations may not be specified via plugins". So the whole decoration
set is a field over the whole document, rather than a plugin over the
viewport. A note is a page of text, so walking all of it costs nothing.

**It is lazily loaded, and that needs the import to be dynamic all the way
down.** The first attempt used `await import()` inside the component while
`liveMarkdown.ts` imported `@codemirror/view` at the top; the package landed
in the entry bundle anyway, since a static import anywhere in the graph is a
static import. The editor is now one `lazy()` boundary in `NoteEditor.tsx`,
which puts all of CodeMirror in a chunk of its own (~174 kB gzipped) that is
fetched when a note is first opened. That is the price of this editor, and it
is why nothing else in the app touches those packages.

## The list is titles

No excerpt, no checkboxes. Both were there in the first version and both were
wrong: the excerpt says less than the title while taking three times the room,
and a column of ticky boxes turns the overview into a second, worse editor.
The list is what a note is called, whether it is pinned, when it last changed.

## The note's id is in the file

`id:` is mel's own, generated when the note is written and never changed. Not
the folder's id, because a note exists before it has a folder: the editor is
open at `/notes/<id>` while the first save is still queued, and an id that
changed when the server answered would pull the address out from under whoever
is typing. (That is not hypothetical — the first cut of this used a `local-`
id and handed over to the folder id the way contacts and events do, and the
editor lost a keystroke and remounted every time a new note was first saved.)

A file mel did not write has no id of its own and borrows its folder's, which
is stable for the same reason. The folder name is cosmetic — a slug of the
title plus four hex digits, fixed when the note is first written, never
renamed afterwards. Renaming it on every title change would be a second write
that can fail on its own, for a name only a file browser ever sees.

## Writes are offline-first, unlike the rest of Files

Files writes are server-first and have no outbox action (`filenode.md`): an
upload has to reach the server to mean anything, and a queued one would park a
50 MB payload in IndexedDB. A note is the opposite case — jotting something
down on a train is the point — so it lands locally and an outbox action carries
it over with the usual retry and backoff.

Two things about that action are worth knowing:

**It carries the note's id, not the note.** The editor saves on every pause,
and a queue holding six snapshots of one note would write six versions of it,
the first five already out of date. Reading the row when the action finally
runs also means the edit made while offline is the one that arrives.

**Every step finds its target before writing it.** The Notes folder is looked
up by name before it is created, the file by the folder it is in, an image
skipped when a file of that name is already there. That is what makes the
action safe to replay after a tab was closed mid-flight, which is why it is in
the outbox's `REPLAYABLE` set.

An untouched note is never queued at all: "new note" and a change of mind
should not leave an empty folder on every device, and there is no title yet to
name a folder after.

## The read model

`db.notes` holds the decoded note; the file is the record. A note's text is
read once and read again only when the file node's `modified` has moved —
which is the delta the Files tree already syncs, so Notes asks the server
nothing the Files app was not going to ask anyway.

One trap found by writing the test for it: a blob that **cannot** be read right
now — offline mid-sync, a server hiccup — must not count as a note that is
gone, or the sweep at the end of the reconcile deletes the last text that was
successfully read while the folder sits happily on the server.

## What is not there yet

- **Due dates** are stored and shown (`due:`), but nothing reminds anyone.
  Reminders wait for the calendar's local alerts (#4/#28) rather than growing a
  second notification path — #88.
- **`linkedTo`** is parsed and written but nothing sets it yet; it is there for
  "make a note about this message" (#86).
- **Sharing** waits on whether Stalwart enforces `shareWith` at all (#89, #75).
- **Encryption does not cover this.** mel's passphrase protects the local
  mirror; the note itself sits on the server as plainly as any mail. Worth
  saying out loud, because "notes" sounds more private than "files".

## Testing

`e2e/notes.spec.ts` covers the three claims that matter: a note written in the
browser comes back after a reload (so it really is a file on the server), a
picture is an ordinary file the **Files app** can see beside `note.md`, and a
note written with the network off arrives once it is back.

Two things the specs have to do that look odd:

The body is **typed**, not filled: the editor is a document, and Enter on a
list line continues the list the way the Markdown keymap does — `fill()` with
a second `- [ ]` in it produces a doubled marker.

The offline test waits for the **body** to appear before cutting the network,
not the title. The title is part of the page; the editor under it is fetched on
demand, so cutting the line in between leaves a note half-open. That is the dev
server's on-demand modules rather than the app — the installed one has them
precached — but it is exactly the kind of thing that reads as a product bug in
a failure log.
