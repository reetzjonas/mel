# Files (JMAP FileNode)

A fourth app beside Mail, Contacts and Calendar: browse folders, upload, create
folders, rename, delete, preview. It rests on `urn:ietf:params:jmap:filenode`,
a **draft** (`draft-ietf-jmap-filenode`, -14 at the time of writing) that few
servers implement — so the tab only exists when the account advertises the
capability, and `connection.files` is null otherwise.

The dev Stalwart (0.16) implements it, and its `accountCapabilities` entry
matches -14 field for field.

## Shape

| Layer | Where |
| --- | --- |
| Domain object | `src/domain/file.ts` |
| JMAP provider | `src/providers/jmap/files.ts`, `mappers/files.ts` |
| Local mirror | `db.files`, synced in `sync/engine.ts` like any other collection |
| Writes | `src/services/files.ts` |
| UI | `src/features/files/`, routes `files.tsx` / `files.index.tsx` / `files.$folderId.tsx` |

Node metadata syncs into IndexedDB, so browsing works offline and delta sync
comes from the shared `syncCollection`. File **contents** do not: they stay on
the server and are fetched on demand, like mail attachments.

### parentKey, not parentId

`FileNodeRow` stores the parent as `parentKey`, with `''` for "top level",
because IndexedDB **skips a record whose indexed key is null**. Storing the
domain object's nullable `parentId` would have left every root node out of the
one index the folder listing is built on, and the root would always have looked
empty. (`mailboxes` declares the same `[accountId+parentId]` index and gets
away with it only because nothing ever queries it — the folder tree is built in
JS from the whole account.)

### Writes are server-first

No outbox action, unlike mail, contacts and calendar. The content has to reach
the server for the write to mean anything, and a queued upload would park the
whole file in IndexedDB — a 50 MB payload in a table built for
`keywords/$seen` patches. So `services/files.ts` reports failure to the caller
and `syncFileTree()` brings the local mirror back in line afterwards. That is
also why the sync engine grew a public entry point for this one collection:
running the whole account sync behind a folder rename would drag every message
header along with it.

## What the server does that the spec does not say

Each of these cost a round of probing; none is guessable from the draft.

**The blob id you upload is not the blob id you get back.** Upload answers with
one id, and the node created from it carries a different one — the server
re-addresses the content on store. So reading a file must use the `blobId` from
a *fetched node*, never the one the upload returned. `readFile` takes the whole
node for exactly this reason.

**`/set` answers a create with `{id}` and nothing else.** The spec says the
server returns every property it set itself; Stalwart returns the id alone. So
`size`, the real `blobId` and the timestamps only appear after a follow-up
fetch — which is what `syncFileTree()` does after every write.

**A parent and its child in one destroy call fails both.** The child comes back
`willDestroy` and the parent `nodeHasChildren`, and no ordering inside the array
helps. `deleteNodes` therefore groups the subtree by depth and sends one call
per level, deepest first. The provider's `destroyNodes` stays a straight
pass-through and does not recurse.

**`parentId: null` is not how you ask for the top level.** That is the separate
`isTopLevel: true` filter condition; a null parent in a query is refused.

**A file may be created with no blob at all.** The draft calls `blobId` required
for `nodeType: "file"`, Stalwart accepts it as null — so a file node in the wild
may have no content, and `readFile` returns null rather than assuming.

**`alreadyExists` carries the colliding node's id** in an `existingId` property
the generic `SetError` shape does not have. Worth reaching for if a caller ever
wants find-or-create in one round trip instead of query-then-create.

## Testing

`e2e/files.spec.ts` drives the real flow against Stalwart: create a folder,
upload into it, assert the size the *server* reports (which is what proves the
content was stored rather than an empty node created), preview, rename, then
delete the folder whole. Desktop-only, like every other state-mutating spec.

`e2e/global-setup.ts` purges file nodes as part of the reset, deepest level
first. Without that, a run that fails before its own cleanup leaves uploads
behind for the next one — the accumulation described in `e2e-stability.md`,
which is exactly how it was found here.

Below `lg` the preview replaces the listing instead of sitting beside it. The
first version had it `hidden lg:flex`, so on a phone tapping a file appeared to
do nothing at all; the mobile Playwright project caught it.
