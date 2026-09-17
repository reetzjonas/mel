/*
 * A note, as mel keeps it in memory.
 *
 * Provider-agnostic like the rest of src/domain: what a note *is* on disk —
 * a Markdown file in a folder of its own — belongs to `lib/noteFile.ts` and
 * the file provider, not here.
 */

/** Where a note came from, for "make a note about this". */
export interface NoteLink {
  type: 'email' | 'event'
  id: string
}

export interface Note {
  /**
   * The note's identity, made by mel and written into the file itself.
   *
   * Not the folder's id: a note is written before it has one, and an id that
   * changes the moment the server answers would pull the address out from
   * under whoever is typing. A file mel did not write has no id of its own and
   * borrows its folder's, which is stable for the same reason.
   */
  id: string
  /** The folder it lives in, null until it has been written. */
  folderId: string | null
  /** The id of `note.md` inside that folder; null until the file exists. */
  fileId: string | null
  /** The folder's name, which is not the title — see notes-app.md. */
  folderName: string
  title: string
  /** Markdown, without the front matter. */
  body: string
  pinned: boolean
  /** A plain date, `YYYY-MM-DD`, or null. */
  due: string | null
  linkedTo: NoteLink | null
  /**
   * Front matter keys mel does not use, kept so that saving a note written by
   * something else does not quietly delete them.
   */
  extra: Record<string, string>
  /** ISO 8601 UTC, from the file node; the empty string for a local-only note. */
  modified: string
}
