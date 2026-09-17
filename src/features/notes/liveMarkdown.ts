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

const setFocused = StateEffect.define<boolean>()

/**
 * Whether the editor has the focus.
 *
 * Markup opens on the line the cursor is in — but CodeMirror keeps its
 * selection when the focus goes elsewhere, so without this a note left by
 * clicking into the title field goes on showing its asterisks on whichever
 * line was last touched, for as long as it is open.
 */
const focused = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFocused)) return effect.value
    return value
  },
})

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
  'QuoteMark',
  'StrikethroughMark',
])

/** `[label](target)`, whose target is hidden while the label stays. */
const INLINE_LINK = /^\[([^\]]*)\]\(.*\)$/

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
  for (const range of state.field(focused) ? state.selection.ranges : []) {
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
      if (node.name === 'Link' && !isOpen(node.from)) {
        /*
         * `[label](target)` reads as the label, underlined. Only this spelling:
         * a bare address is a Link too, and hiding *its* target would hide the
         * only text there is.
         */
        const text = state.doc.sliceString(node.from, node.to)
        const label = INLINE_LINK.exec(text)?.[1]
        if (label !== undefined) {
          marks.push(hidden.range(node.from, node.from + 1))
          marks.push(hidden.range(node.from + 1 + label.length, node.to))
          return false
        }
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
    /*
     * A selection change matters as much as an edit here — that is what opens
     * and closes a line's markup — and so does losing the focus, which closes
     * all of them. Leaving the effects out of this condition is why the first
     * version went on showing the asterisks of the last line touched after the
     * editor was left: the state said "not focused" and nothing redrew.
     */
    const effect = tr.effects.some((e) => e.is(setNoteImages) || e.is(setFocused))
    if (!tr.docChanged && !tr.selection && !effect) return value.map(tr.changes)
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
  // The two fields the decorations read, before the field that reads them.
  return [
    noteImages,
    focused,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
    livePreview,
  ]
}
