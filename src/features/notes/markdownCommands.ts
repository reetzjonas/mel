/*
 * Writing Markdown without typing Markdown.
 *
 * Each command takes the editor's state and says what should change, which is
 * why they live here rather than in the toolbar: a button is then three lines,
 * and the awkward parts — what "bold" means with nothing selected, what
 * happens to a bullet that is already a heading — can be tested without a
 * browser.
 *
 * They are edits to Markdown *text*, not to a document model. Pressing bold
 * writes the asterisks the file would have had anyway, which is what keeps the
 * buffer the file (see liveMarkdown.ts).
 */

import type { EditorState, TransactionSpec } from '@codemirror/state'

/** What every command here is: a look at the state, and an edit to make. */
export type MarkdownCommand = (state: EditorState) => TransactionSpec

/** Word characters, for deciding what "bold" applies to when nothing is selected. */
const WORD = /[\p{L}\p{N}_]/u

interface Span {
  from: number
  to: number
}

/**
 * What the command should act on: the selection, or the word under the cursor.
 *
 * Wrapping nothing at all is the useless case — an empty `****` that the next
 * keystroke lands outside of — and asking people to select a word before
 * making it bold is the thing a toolbar is meant to save them.
 */
function target(state: EditorState): Span {
  const range = state.selection.main
  if (!range.empty) return { from: range.from, to: range.to }
  const line = state.doc.lineAt(range.head)
  let from = range.head
  let to = range.head
  while (from > line.from && WORD.test(state.doc.sliceString(from - 1, from))) from--
  while (to < line.to && WORD.test(state.doc.sliceString(to, to + 1))) to++
  return { from, to }
}

/**
 * Add or remove a pair of markers around the selection.
 *
 * Unwrapping looks *outside* the selection as well: double-clicking a bold
 * word selects the word, not the asterisks around it, and a bold button that
 * then made it bold twice would be a button that cannot be undone with itself.
 */
export function toggleWrap(state: EditorState, mark: string): TransactionSpec {
  const { from, to } = target(state)
  const inside = state.doc.sliceString(from, to)
  const width = mark.length

  if (inside.startsWith(mark) && inside.endsWith(mark) && inside.length >= width * 2) {
    return {
      changes: { from, to, insert: inside.slice(width, -width) },
      selection: { anchor: from, head: to - width * 2 },
    }
  }

  const before = state.doc.sliceString(Math.max(0, from - width), from)
  const after = state.doc.sliceString(to, Math.min(state.doc.length, to + width))
  if (before === mark && after === mark) {
    return {
      changes: [
        { from: from - width, to: from },
        { from: to, to: to + width },
      ],
      selection: { anchor: from - width, head: to - width },
    }
  }

  return {
    changes: { from, to, insert: `${mark}${inside}${mark}` },
    // Inside the markers, so typing carries on where the writing was.
    selection: { anchor: from + width, head: to + width },
  }
}

/** Every line the selection touches, top to bottom. */
function selectedLines(state: EditorState) {
  const { from, to } = state.selection.main
  const first = state.doc.lineAt(from).number
  const last = state.doc.lineAt(to).number
  return Array.from({ length: last - first + 1 }, (_, i) => state.doc.line(first + i))
}

/** What a line already carries at its start, so one marker can replace another. */
const LINE_MARKERS = /^(\s*)(#{1,6} |[-*] \[[ xX]\] |[-*] |\d+\. |> )?/

/**
 * Put a marker at the start of every line in the selection, or take it away.
 *
 * Markers replace each other rather than stacking: a line that is a bullet
 * becomes a heading, it does not become a bulleted heading. That is the part a
 * toolbar has to get right, because it is exactly what is tedious to do by
 * hand.
 */
export function toggleLinePrefix(state: EditorState, prefix: string): TransactionSpec {
  const lines = selectedLines(state)
  const has = lines.every((line) => LINE_MARKERS.exec(line.text)?.[2] === prefix)
  const changes = lines.map((line) => {
    const [, indent = '', marker = ''] = LINE_MARKERS.exec(line.text) ?? []
    const from = line.from + indent.length
    return { from, to: from + marker.length, insert: has ? '' : prefix }
  })
  return { changes }
}

/**
 * Turn the line into a checklist item, or back into an ordinary one.
 *
 * Ticking a box is the checkbox's own job (liveMarkdown.ts); this is the one
 * that decides whether there is a box at all.
 */
export function toggleTask(state: EditorState): TransactionSpec {
  const lines = selectedLines(state)
  const isTask = (text: string) => /^\s*[-*] \[[ xX]\] /.test(text)
  const all = lines.every((line) => isTask(line.text))
  const changes = lines.map((line) => {
    const [, indent = '', marker = ''] = LINE_MARKERS.exec(line.text) ?? []
    const from = line.from + indent.length
    return { from, to: from + marker.length, insert: all ? '' : '- [ ] ' }
  })
  return { changes }
}

const URL_LIKE = /^(https?:\/\/|mailto:|www\.)\S+$/i

/**
 * A link around the selection.
 *
 * With a URL in hand — pasted over a selection — the selected words become the
 * label. Without one, the label is what was selected and the cursor lands
 * between the brackets where the address goes, which is the only part the
 * writer still has to supply.
 */
export function insertLink(state: EditorState, url = ''): TransactionSpec {
  const { from, to } = target(state)
  const label = state.doc.sliceString(from, to)
  const insert = `[${label}](${url})`
  const caret = from + label.length + 3
  return {
    changes: { from, to, insert },
    selection: url ? { anchor: from + insert.length } : { anchor: caret },
  }
}

/** Whether pasted text is a bare address, and so worth turning into a link. */
export function looksLikeUrl(text: string): boolean {
  return URL_LIKE.test(text.trim())
}
