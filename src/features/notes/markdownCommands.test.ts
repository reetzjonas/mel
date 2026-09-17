import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  insertLink,
  looksLikeUrl,
  toggleLinePrefix,
  toggleTask,
  toggleWrap,
} from './markdownCommands'

/*
 * A document with `‸` for the cursor, or `«` and `»` around a selection.
 *
 * Not `[`, `]` and `|`, which is where this started: those are Markdown's own
 * checkbox and table characters, so `- [x] a‸b` had its brackets eaten by the
 * helper and the test failed on input it never had.
 */
function stateOf(marked: string): EditorState {
  const selection = marked.includes('«')
    ? { anchor: marked.indexOf('«'), head: marked.indexOf('»') - 1 }
    : { anchor: marked.indexOf('‸') }
  return EditorState.create({ doc: marked.replace(/[‸«»]/g, ''), selection })
}

/** The document after the command, without any marker in it. */
function textAfter(marked: string, spec: ReturnType<typeof toggleWrap>): string {
  return stateOf(marked).update(spec).state.doc.toString()
}

/** The document after the command, with the selection marked back in. */
function apply(marked: string, spec: ReturnType<typeof toggleWrap>): string {
  const state = stateOf(marked)
  const next = state.update(spec).state
  const { from, to } = next.selection.main
  const doc = next.doc.toString()
  return from === to
    ? `${doc.slice(0, from)}‸${doc.slice(from)}`
    : `${doc.slice(0, from)}«${doc.slice(from, to)}»${doc.slice(to)}`
}

describe('bold and italic', () => {
  it('wraps the selection', () => {
    expect(
      apply('Milch «nicht» vergessen', toggleWrap(stateOf('Milch «nicht» vergessen'), '**')),
    ).toBe('Milch **«nicht»** vergessen')
  })

  it('wraps the word under the cursor when nothing is selected', () => {
    // Asking someone to select a word before pressing bold is the work a
    // toolbar exists to save.
    expect(
      apply('Milch ni‸cht vergessen', toggleWrap(stateOf('Milch ni‸cht vergessen'), '**')),
    ).toBe('Milch **«nicht»** vergessen')
  })

  it('takes the markers away again, from inside the selection', () => {
    expect(apply('Milch «**nicht**» weg', toggleWrap(stateOf('Milch «**nicht**» weg'), '**'))).toBe(
      'Milch «nicht» weg',
    )
  })

  it('takes them away when only the word is selected', () => {
    // Double-clicking a bold word selects the word, not the asterisks; a bold
    // button that then bolded it twice could not undo itself.
    expect(apply('Milch **«nicht»** weg', toggleWrap(stateOf('Milch **«nicht»** weg'), '**'))).toBe(
      'Milch «nicht» weg',
    )
  })

  it('leaves the cursor where the writing carries on', () => {
    expect(apply('Milch ‸', toggleWrap(stateOf('Milch ‸'), '*'))).toBe('Milch *‸*')
  })
})

describe('line markers', () => {
  it('adds one to every line the selection touches', () => {
    const doc = '«eins\nzwei»'
    expect(textAfter(doc, toggleLinePrefix(stateOf(doc), '- '))).toBe('- eins\n- zwei')
  })

  it('takes it away when every line already has it', () => {
    const doc = '«- eins\n- zwei»'
    expect(textAfter(doc, toggleLinePrefix(stateOf(doc), '- '))).toBe('eins\nzwei')
  })

  it('replaces one marker with another rather than stacking them', () => {
    // A bullet that is made a heading is a heading, not a bulleted heading.
    const doc = '- ein‸s'
    expect(textAfter(doc, toggleLinePrefix(stateOf(doc), '# '))).toBe('# eins')
  })

  it('keeps the indentation a nested item was written with', () => {
    const doc = '  - ein‸s'
    expect(textAfter(doc, toggleLinePrefix(stateOf(doc), '> '))).toBe('  > eins')
  })
})

describe('checklists', () => {
  it('turns a line into an item and back', () => {
    expect(textAfter('Milch‸', toggleTask(stateOf('Milch‸')))).toBe('- [ ] Milch')

    const done = '- [x] Mil‸ch'
    expect(textAfter(done, toggleTask(stateOf(done)))).toBe('Milch')
  })

  it('turns a plain bullet into one without doubling the marker', () => {
    const doc = '- Mil‸ch'
    expect(textAfter(doc, toggleTask(stateOf(doc)))).toBe('- [ ] Milch')
  })
})

describe('links', () => {
  it('leaves the cursor where the address goes', () => {
    expect(apply('siehe «hier» nach', insertLink(stateOf('siehe «hier» nach')))).toBe(
      'siehe [hier](‸) nach',
    )
  })

  it('uses a pasted address and keeps the words as the label', () => {
    const doc = 'siehe «hier» nach'
    expect(apply(doc, insertLink(stateOf(doc), 'https://example.com'))).toBe(
      'siehe [hier](https://example.com)‸ nach',
    )
  })

  it('recognises what is worth turning into a link', () => {
    expect(looksLikeUrl('https://example.com/x')).toBe(true)
    expect(looksLikeUrl('  www.example.com ')).toBe(true)
    expect(looksLikeUrl('mailto:erika@example.com')).toBe(true)
    expect(looksLikeUrl('nur Text')).toBe(false)
    expect(looksLikeUrl('https://example.com and more')).toBe(false)
  })
})
