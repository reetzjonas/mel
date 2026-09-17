/*
 * A note as a file: Markdown with front matter.
 *
 * The format is the whole point of the feature's design, so it is worth
 * stating plainly. A note is not an opaque blob mel invented — it is a
 * Markdown document any editor, any WebDAV mount and mel's own Files app can
 * read, with the handful of things Markdown has no place for (pinned, due,
 * where the note came from) in a front matter block:
 *
 *     ---
 *     title: Einkauf
 *     pinned: true
 *     ---
 *     - [ ] Milch
 *
 * The parser is a small one on purpose. Front matter is conventionally YAML,
 * but a note only ever needs `key: value` on one line, and a YAML dependency
 * to read five scalars would be the largest thing in the bundle for the least
 * reason. Anything it cannot make sense of is kept as it stands rather than
 * dropped — the same rule the calendar's recurrence patches follow, and for
 * the same reason: mel rewrites the whole file when it saves.
 */

import type { Note, NoteLink } from '../domain/note'

const FENCE = '---'

/** Keys this app understands; everything else on a line of its own is kept. */
const KNOWN = new Set(['id', 'title', 'pinned', 'due', 'linked'])

function parseLink(value: string): NoteLink | null {
  const [type, ...rest] = value.split(':')
  const id = rest.join(':').trim()
  if (!id || (type !== 'email' && type !== 'event')) return null
  return { type, id }
}

function formatLink(link: NoteLink | null): string | null {
  return link ? `${link.type}:${link.id}` : null
}

interface FrontMatter {
  fields: Map<string, string>
  body: string
}

/**
 * Split a document into its front matter and the rest.
 *
 * A file with no front matter is not an error: someone may have dropped an
 * ordinary Markdown file into the folder, and reading it as a note with no
 * title beats refusing to show it.
 */
function splitFrontMatter(text: string): FrontMatter {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== FENCE) return { fields: new Map(), body: text }

  const end = lines.findIndex((line, i) => i > 0 && line.trim() === FENCE)
  // An unterminated block is a file that was cut short; treating the whole of
  // it as front matter would hide the text, so it counts as having none.
  if (end === -1) return { fields: new Map(), body: text }

  const fields = new Map<string, string>()
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  return {
    fields,
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n/, ''),
  }
}

/** The first heading or line of the body, for a file that carries no title. */
function titleFromBody(body: string): string {
  const first = body.split('\n').find((line) => line.trim().length > 0) ?? ''
  return first.replace(/^#+\s*/, '').trim()
}

/**
 * Read a note file.
 *
 * The identity fields — which file this was, when it changed — come from the
 * file node, not from the document, so they are passed in rather than parsed.
 */
export function parseNote(
  text: string,
  at: {
    /** Used as the note's id when the file carries none of its own. */
    folderId: string
    fileId: string | null
    folderName: string
    modified: string
  },
): Note {
  const { fields, body } = splitFrontMatter(text)
  const extra: Record<string, string> = {}
  for (const [key, value] of fields) if (!KNOWN.has(key)) extra[key] = value

  return {
    ...at,
    id: fields.get('id')?.trim() || at.folderId,
    title: fields.get('title')?.trim() || titleFromBody(body),
    // One trailing newline is how a text file ends, not part of what was
    // written; serializeNote puts it back, so a note round-trips unchanged.
    body: body.replace(/\n$/, ''),
    pinned: fields.get('pinned') === 'true',
    due: fields.get('due')?.trim() || null,
    linkedTo: parseLink(fields.get('linked') ?? ''),
    extra,
  }
}

/**
 * Write a note file.
 *
 * Front matter only where there is something to say: a plain note with no
 * title, no pin and no date is written as plain Markdown, which is what
 * someone opening it in an editor should find.
 */
export function serializeNote(note: Note): string {
  const fields: Array<[string, string]> = [['id', note.id]]
  if (note.title.trim() && note.title.trim() !== titleFromBody(note.body)) {
    fields.push(['title', note.title.trim()])
  }
  if (note.pinned) fields.push(['pinned', 'true'])
  if (note.due) fields.push(['due', note.due])
  const linked = formatLink(note.linkedTo)
  if (linked) fields.push(['linked', linked])
  for (const [key, value] of Object.entries(note.extra)) fields.push([key, value])

  const body = note.body.replace(/\s+$/, '')
  if (!fields.length) return body ? `${body}\n` : ''
  const block = fields.map(([k, v]) => `${k}: ${v}`).join('\n')
  return `${FENCE}\n${block}\n${FENCE}\n${body ? `\n${body}\n` : ''}`
}

/** Images the body refers to, as the file names they were written with. */
const IMAGE_REF = /!\[[^\]]*\]\(([^)\s]+)\)/g

export function imageNames(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(IMAGE_REF)) {
    const name = decodeURIComponent(m[1]!)
    // Only files beside the note: anything with a slash or a scheme points
    // somewhere mel does not own and is left to be read as text.
    if (!name.includes('/') && !name.includes(':') && !out.includes(name)) out.push(name)
  }
  return out
}

/** The Markdown for an image sitting next to the note. */
export function imageRef(name: string): string {
  return `![${name}](${encodeURIComponent(name)})`
}

/**
 * A folder name for a new note.
 *
 * Readable, because this is what someone browsing the same account in a file
 * manager sees, and unique, because the server refuses two children with the
 * same name and two notes called "Einkauf" is an ordinary thing to want. The
 * name is fixed at creation: renaming the folder every time the title changes
 * would be a second write that can fail on its own, and the title in the front
 * matter is what mel shows anyway.
 */
export function noteFolderName(title: string, suffix = crypto.randomUUID().slice(0, 4)): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${slug || 'note'}-${suffix}`
}
