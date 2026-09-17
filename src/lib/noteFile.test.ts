import { describe, expect, it } from 'vitest'
import type { Note } from '../domain/note'
import { imageNames, imageRef, noteFolderName, parseNote, serializeNote } from './noteFile'

const at = {
  folderId: 'd1',
  fileId: 'f1',
  folderName: 'einkauf-1a2b',
  modified: '2026-09-17T10:00:00Z',
}

const note = (over: Partial<Note> = {}): Note => ({
  ...at,
  id: 'n1',
  title: 'Einkauf',
  body: '- [ ] Milch',
  pinned: false,
  due: null,
  linkedTo: null,
  extra: {},
  ...over,
})

describe('parseNote', () => {
  it('reads the front matter and leaves the body alone', () => {
    const parsed = parseNote(
      '---\nid: n1\ntitle: Einkauf\npinned: true\ndue: 2026-09-20\nlinked: email:M1\n---\n\n- [ ] Milch\n',
      at,
    )

    expect(parsed).toMatchObject({
      title: 'Einkauf',
      pinned: true,
      due: '2026-09-20',
      linkedTo: { type: 'email', id: 'M1' },
      // The file's closing newline is how a text file ends, not something the
      // editor should find in the box.
      body: '- [ ] Milch',
    })
  })

  it('borrows the folder id for a file that carries no id of its own', () => {
    // Something else wrote it, so there is nothing in the document to go by;
    // the folder is as stable an identity as that file has.
    expect(parseNote('just text', at).id).toBe('d1')
    expect(parseNote('---\nid: kept\n---\ntext', at).id).toBe('kept')
  })

  it('reads a plain Markdown file as a note, titled by its first line', () => {
    // Someone may simply have dropped a file into the folder; refusing to show
    // it would be worse than showing it without a title of its own.
    const parsed = parseNote('# Ideas\n\nsomething', at)

    expect(parsed.title).toBe('Ideas')
    expect(parsed.body).toBe('# Ideas\n\nsomething')
    expect(parsed.pinned).toBe(false)
  })

  it('treats an unterminated front matter block as text, not as fields', () => {
    // The alternative is hiding the whole document behind a fence that never
    // closed, which looks to the reader like the note lost its contents.
    const parsed = parseNote('---\ntitle: broken\n\nstill writing', at)

    expect(parsed.body).toBe('---\ntitle: broken\n\nstill writing')
  })

  it('keeps front matter keys it does not know', () => {
    const parsed = parseNote('---\ntitle: T\ncolor: red\n---\nbody', at)

    expect(parsed.extra).toEqual({ color: 'red' })
    expect(serializeNote(parsed)).toContain('color: red')
  })

  it('ignores a link it cannot make sense of', () => {
    expect(parseNote('---\nlinked: nonsense\n---\nx', at).linkedTo).toBeNull()
    expect(parseNote('---\nlinked: email:\n---\nx', at).linkedTo).toBeNull()
  })
})

describe('serializeNote', () => {
  it('round-trips everything it wrote', () => {
    const before = note({ pinned: true, due: '2026-09-20', linkedTo: { type: 'event', id: 'E1' } })

    expect(parseNote(serializeNote(before), at)).toEqual(before)
  })

  it('leaves out a title the body already carries', () => {
    // The id is the one field always written: it is what the note is called
    // again after a sync, whatever the folder ends up named.
    expect(serializeNote(note({ title: 'Ideas', body: '# Ideas\n\nmore' }))).toBe(
      '---\nid: n1\n---\n\n# Ideas\n\nmore\n',
    )
  })

  it('writes an empty note as nothing but its id', () => {
    expect(serializeNote(note({ title: '', body: '' }))).toBe('---\nid: n1\n---\n')
  })
})

describe('images', () => {
  it('finds the files a note refers to, once each', () => {
    expect(imageNames('![](foto.jpg)\n\n![again](foto.jpg) ![](plan%20b.png)')).toEqual([
      'foto.jpg',
      'plan b.png',
    ])
  })

  it('ignores anything that is not a file beside the note', () => {
    // A remote image is somebody else's server, and a path points outside the
    // folder mel owns; both stay as text rather than being fetched.
    expect(imageNames('![](https://example.com/x.png) ![](../up.png)')).toEqual([])
  })

  it('writes a reference the parser reads back', () => {
    expect(imageNames(imageRef('plan b.png'))).toEqual(['plan b.png'])
  })
})

describe('noteFolderName', () => {
  it('is readable to someone browsing the files', () => {
    expect(noteFolderName('Einkauf für Montag', 'ab12')).toBe('einkauf-fur-montag-ab12')
  })

  it('always has a name, even for a note that has none yet', () => {
    expect(noteFolderName('', 'ab12')).toBe('note-ab12')
    expect(noteFolderName('🙂', 'ab12')).toBe('note-ab12')
  })

  it('stays short enough for a file system to take it', () => {
    expect(noteFolderName('x'.repeat(200), 'ab12').length).toBeLessThanOrEqual(45)
  })
})
