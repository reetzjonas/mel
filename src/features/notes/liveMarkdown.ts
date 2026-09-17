/*
 * The decorations that make a Markdown buffer read like the document it
 * describes — the Obsidian trick, and the reason notes are edited in
 * CodeMirror rather than in a rich-text editor.
 *
 * Nothing here converts anything. The buffer *is* the file, byte for byte;
 * these only draw over it: the `**` around a bold word is hidden, `- [ ]`
 * becomes a checkbox, an image reference grows the picture underneath. Move
 * the cursor onto a line and its markup comes back, because that is the line
 * you are editing.
 *
 * A WYSIWYG editor would have had to parse Markdown into a document and write
 * it back out on every save, and the first note written by another tool with
 * syntax mel does not model would have come back mangled. That trade is the
 * whole argument for this file.
 */

import { syntaxTree } from '@codemirror/language'
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

/** Picture URLs by file name, handed in as they resolve. */
export const setNoteImages = StateEffect.define<Record<string, string>>()

const noteImages = StateField.define<Record<string, string>>({
  create: () => ({}),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setNoteImages)) return effect.value
    return value
  },
})

/** Markup characters that only describe formatting, and can be drawn out of the way. */
const MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'StrongEmphasisMark',
  'CodeMark',
  'LinkMark',
  'QuoteMark',
  'StrikethroughMark',
])

class CheckboxWidget extends WidgetType {
  readonly checked: boolean
  readonly pos: number

  constructor(checked: boolean, pos: number) {
    super()
    this.checked = checked
    this.pos = pos
  }

  override eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = 'mel-task'
    box.setAttribute('aria-label', taskLabel(view, this.pos))
    box.addEventListener('mousedown', (e) => {
      // The click must not move the caret into the line, or the markup springs
      // back open under the pointer as the box is ticked.
      e.preventDefault()
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: this.checked ? '[ ]' : '[x]' },
      })
    })
    return box
  }

  override ignoreEvent() {
    return false
  }
}

const TASK_LINE = /^\s*[-*]\s+\[( |x|X)\]/

function isTaskLine(state: EditorState, pos: number): boolean {
  return TASK_LINE.test(state.doc.lineAt(pos).text)
}

/** What the item next to a checkbox says, so the box has a name to be found by. */
function taskLabel(view: EditorView, pos: number): string {
  const line = view.state.doc.lineAt(pos)
  return line.text.replace(/^\s*[-*]\s+\[( |x|X)\]\s?/, '').trim()
}

class ImageWidget extends WidgetType {
  readonly name: string
  readonly url: string

  constructor(name: string, url: string) {
    super()
    this.name = name
    this.url = url
  }

  override eq(other: ImageWidget) {
    return other.url === this.url && other.name === this.name
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'mel-note-image'
    const img = document.createElement('img')
    img.src = this.url
    img.alt = this.name
    wrap.appendChild(img)
    return wrap
  }
}

const hidden = Decoration.replace({})

/*
 * Built from the state rather than from a view plugin, because the picture
 * under a line is a *block* widget and CodeMirror takes those only from a
 * field. The whole document is walked instead of the viewport, which a note
 * can afford: it is a page of text, not a source file.
 */
function decorate(state: EditorState): DecorationSet {
  const marks: Range<Decoration>[] = []
  const images = state.field(noteImages)
  /*
   * Lines the selection touches keep their markup: the moment the cursor is in
   * a line, the thing being edited is the text, and a hidden `**` is a
   * character that cannot be deleted by anyone who cannot see it.
   */
  const open = new Set<number>()
  for (const range of state.selection.ranges) {
    const from = state.doc.lineAt(range.from).number
    const to = state.doc.lineAt(range.to).number
    for (let line = from; line <= to; line++) open.add(line)
  }
  const isOpen = (pos: number) => open.has(state.doc.lineAt(pos).number)

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'ListMark' && isTaskLine(state, node.from) && !isOpen(node.from)) {
        // The `- ` in front of a checkbox says nothing the box does not: two
        // markers for one item, one of which is already a control.
        marks.push(hidden.range(node.from, Math.min(node.to + 1, state.doc.lineAt(node.to).to)))
        return
      }
      if (node.name === 'TaskMarker') {
        const checked = state.doc.sliceString(node.from, node.to).toLowerCase() === '[x]'
        // Always a real checkbox, cursor or not: it is the one piece of markup
        // that is also a control, and a list you cannot tick while editing it
        // is a list with a mode.
        marks.push(
          Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(
            node.from,
            node.to,
          ),
        )
        return
      }
      if (node.name === 'Image') {
        const text = state.doc.sliceString(node.from, node.to)
        const name = decodeURIComponent(/\(([^)]*)\)/.exec(text)?.[1] ?? '')
        const url = images[name]
        if (url) {
          marks.push(
            Decoration.widget({ widget: new ImageWidget(name, url), side: 1, block: true }).range(
              state.doc.lineAt(node.to).to,
            ),
          )
          if (!isOpen(node.from)) marks.push(hidden.range(node.from, node.to))
        }
        return
      }
      if (MARKS.has(node.name) && !isOpen(node.from) && node.to > node.from) {
        marks.push(hidden.range(node.from, node.to))
      }
    },
  })
  marks.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)
  return Decoration.set(marks, true)
}

const livePreview = StateField.define<DecorationSet>({
  create: (state) => decorate(state),
  update(value, tr) {
    // A selection change matters as much as an edit here: that is what opens
    // and closes a line's markup.
    const images = tr.effects.some((e) => e.is(setNoteImages))
    if (!tr.docChanged && !tr.selection && !images) return value.map(tr.changes)
    return decorate(tr.state)
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    /*
     * Atomic, so a hidden `**` is stepped over rather than walked into with an
     * arrow key. Without this the caret can sit inside markup that is not on
     * screen, and the next keystroke lands in the middle of it.
     */
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
})

export function liveMarkdown(): Extension {
  // The images field first: the decorations read it as they are built.
  return [noteImages, livePreview]
}
