# Conversations (#37)

The mail list groups messages into conversations by `threadId` — **a view
preference** (Settings → Conversations, default on, localStorage
`mel:conversations`, mirrored into `app/store.ts` so flipping it reaches the
mounted list). Nothing new is synced: `threadId` was already an index column
(`[accountId+threadId]`), and the dead `threads` table stays dead.

A conversation **spans folders** (the user's call): the count and the
participants include your own replies in Sent, so a row can say "4 messages"
while only two of them are in the inbox. What the row *acts* on is narrower —
`Conversation.ids` holds only the messages in the listed mailbox, so archiving
an inbox row cannot reach into Sent. Unread/flagged aggregate over those same
in-folder messages: an unread copy in Archive must not put a dot on a row that
holds nothing you could read to clear it. Messages living **only** in trash or
junk are left out entirely, unless that is the folder you are in.

Three things that were not obvious:

- **Two account-wide index reads are cached in `listIndex.ts`**: the thread
  membership (`getThreadIndex`) and the order every folder is listed in
  (`getDateOrder`). Neither depends on the folder, and recomputing them per
  folder open was what made opening a folder cost ~1.5s on a 36k-message
  account — an *empty* folder just as much, since the work covered the account.
  Now: ~0.8s for the first folder of a session (both scans), then ~0.2s for a
  36k folder and **~20ms for a small or empty one**. See the `keys()` gotcha
  in `docs/notes/gotchas-dexie-performance.md` for the measurements.
  `resetListIndexes()` is needed wherever rows vanish without the table hooks
  seeing it (`removeAccount`, test setup): a range delete reports no rows.
  The thread index is **patched** per changed row; the date order is
  **invalidated**, because an id array cannot be spliced without knowing the
  dates around the new entry and those are not in the primary keys the scan
  reads. Read, flag, move, archive and delete leave the order alone, so only an
  arriving or destroyed message drops it — pinned by a test that counts the
  scans.
  The thread scan is `getAllKeys` over `[accountId+threadId]` (ids ordered by
  thread, then id) plus **one cursor step per distinct thread** (`nextunique`,
  which also reports that thread's *first* primary key); `splitThreads()` cuts
  the id array at those firsts. Both reads share **one** transaction, or the two
  snapshots could disagree and messages would land under the wrong thread; the
  old pairing did not, which was a latent bug during sync. `splitThreads()`
  returns null rather than guessing if they do not line up, and the caller falls
  back to the old key-cursor pairing. Pinned by `listIndex.test.ts` (including a
  test that fails if the cursor fallback starts running) and by `hooks.test.tsx`
  ("counts the messages in other folders…").
  What is left scales with the **folder**, not the account: enumerating a 36k
  folder's own ids costs ~130ms, an empty one ~3ms (issues #46/#47 track the
  rest).
- **Long threads fold in the middle** (`foldThread()`, pure and tested): the
  first message, the last two, the open one and anything that just arrived
  stay; runs of two or more in between become a band you click. Ten replies
  otherwise push the message you came to read off the screen.
- **Trash, junk and drafts are excluded** (`hiddenMailboxIds()`), unless that
  is the folder you are in — an unsent draft is not part of the exchange, since
  nothing in it has been seen by the other side. The reading pane applies the
  very same rule via `useThread`, or the header would say "10 messages" over a
  stack of twelve.
- **A message arriving under the open pane is marked** (`NEW` chip, accent row,
  scrolled into view once) and never folded away. Which messages count as new
  is seeded *after* the thread query resolves — seeding from the routed message
  alone makes the whole thread look like it just turned up.
  **`useLiveQuery` hands back the previous query's result while the new one
  runs**, so for one render after another message is opened `useThread` still
  describes the conversation you came from. Seeding from *that* marked every
  message of the newly opened thread as new — reported from a real account as
  "everything says NEW". `threadForMessage()` (pure, tested) drops a thread
  that does not contain the routed message, and both the seeding and the
  rendered message list go through it. Pinned in `e2e/threads.spec.ts`
  (switching messages, then back — verified to fail without the fix).
- **Exactly one message is expanded in the reading pane.** Not a design
  preference: a body renders in a sandboxed iframe *without*
  `allow-same-origin` (mail scripts must never reach our origin), so its
  content height cannot be measured from the parent — stacked bodies would each
  need a guessed height. The folded messages are one-line rows and the open one
  takes what is left, with a `min-h-96` floor so a long thread scrolls instead
  of squeezing the body to nothing.
- **Archive and delete take the open message; the conversation is a second
  choice behind a caret.** They used to take the whole conversation, which the
  user found too blunt — the two differ by every other message in the thread and
  only the snackbar ever said which had happened. In the reading pane the two
  buttons are now `SplitAction` (ReadingPane.tsx): the button itself is the one
  message, the caret opens a two-entry menu ("Archive" / "Archive
  conversation"). The `e`/`#` shortcuts follow the button's default and take the
  single message — `targetIds()` is gone. **The list row still acts on its whole
  conversation**, because a row *is* the conversation (it carries the count);
  the pane is where one message can be singled out — but its **tooltips say
  so**, in three cases, because the icons are identical either way:
  `ids.length > 1` → "Archive conversation"; a row that counts several messages
  but holds only one *here* → "Archive this message"; a plain single message →
  "Archive". That middle case is the common inbox shape (they wrote once, your
  replies are in Sent) and it is why the first attempt looked broken: only the
  top row changed its tooltip, and the rows below were genuinely acting on one
  message while their badge said four. The reading pane splits on the same
  quantity (`splitScope = threadIds.length > 1`, not `isThread`) — a caret
  offering the same act twice is worse than no caret. Flag, unread, reply and
  not-spam stay on the one message they can sensibly mean, as before.

**Search results are never grouped**: a search answers with the messages that
matched, not with the threads they sit in. The list row component takes one
`RowItem` either way, so a message row and a conversation row cannot drift
apart, and all row actions go through the `bulk*` services with a single id when
there is only one.
