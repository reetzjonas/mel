import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import { liveMarkdown, setNoteImages } from './liveMarkdown'

/*
 * Sizes and weights only: every colour comes from the app's own tokens, so a
 * note follows the theme and the theme editor like any other surface.
 */
const look = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.5em', fontWeight: '600', lineHeight: '1.9' },
  { tag: tags.heading2, fontSize: '1.25em', fontWeight: '600', lineHeight: '1.8' },
  { tag: tags.heading3, fontSize: '1.1em', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--mel-accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--mel-accent)' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, monospace' },
  { tag: tags.quote, color: 'var(--mel-ink-muted)', fontStyle: 'italic' },
])

/**
 * The note's text, shown the way it will read.
 *
 * CodeMirror rather than a rich-text editor, because the document under it has
 * to stay the file: what is typed here is what `note.md` contains, and the
 * formatting is drawn on top of it (`liveMarkdown.ts`).
 *
 * A default export, so the one place that uses it can load it lazily: this
 * module and what it pulls in is the heaviest thing in the app, and nobody who
 * never opens a note should pay for it.
 */
export default function MarkdownEditor({
  value,
  images,
  placeholder,
  ariaLabel,
  onChange,
}: {
  value: string
  /** Picture URLs by file name, for the images the text refers to. */
  images: Record<string, string>
  placeholder: string
  ariaLabel: string
  onChange: (value: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  /*
   * What the editor is built from and what it reports to, both as refs. It is
   * built once: rebuilding it on a prop change — which is every keystroke —
   * would throw away the undo history and the cursor with it.
   */
  const initial = useRef({ value, placeholder, ariaLabel })
  const latest = useRef(onChange)
  useEffect(() => {
    latest.current = onChange
  })

  useEffect(() => {
    const el = host.current
    if (!el) return
    const editor = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: initial.current.value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(look),
          liveMarkdown(),
          EditorView.lineWrapping,
          placeholderExt(initial.current.placeholder),
          EditorView.contentAttributes.of({
            'aria-label': initial.current.ariaLabel,
            role: 'textbox',
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [])

  // The document, when it changed somewhere other than in here — a note
  // arriving from the server, or a button in the toolbar above.
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const current = editor.state.doc.toString()
    if (current === value) return
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: setNoteImages.of(images) })
  }, [images])

  return <div ref={host} className="mel-note-editor min-h-0 flex-1 overflow-y-auto" />
}
