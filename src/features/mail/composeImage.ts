import { mergeAttributes, Node, type Editor } from '@tiptap/react'

/*
 * Pictures in the compose editor.
 *
 * The document holds what the message will say — `<img src="cid:…">` — and
 * only the node view on screen swaps that for a URL the browser can draw. So
 * `editor.getHTML()` is already the body to send or save, and no step has to
 * remember to turn display URLs back into references (a `blob:` URL that
 * slipped into a sent message would be a broken image for everyone else).
 *
 * Only `cid:` and `data:` sources are taken in. A remote picture pasted or
 * quoted into the editor is dropped, as it was before this node existed:
 * drawing it would fetch it — the tracking pixel of the message being answered
 * — and sending it on would pass the tracker along.
 */

export interface InlineImageStorage {
  /** Display URL per Content-ID, filled in as pictures are staged or fetched. */
  urls: Map<string, string>
  listeners: Set<() => void>
}

const ALLOWED_SRC = /^(cid:|data:image\/)/i

export const InlineImage = Node.create<Record<string, never>, InlineImageStorage>({
  name: 'inlineImage',
  inline: true,
  group: 'inline',
  draggable: true,
  atom: true,

  addStorage() {
    return { urls: new Map(), listeners: new Set() }
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (element) => (ALLOWED_SRC.test(element.getAttribute('src') ?? '') ? null : false),
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    // The style goes out with the message: a phone screenshot is wider than
    // most reading panes, and not every client scales pictures down.
    return ['img', mergeAttributes(HTMLAttributes, { style: 'max-width: 100%; height: auto;' })]
  },

  addNodeView() {
    // The editor's own storage: `extension.storage` in the view's props is
    // the extension's default, not the instance that setInlineImageUrl fills.
    const storage = this.storage
    return ({ node }) => {
      const img = document.createElement('img')
      img.className = 'compose-inline-image'
      img.draggable = true
      let current = node
      const draw = () => {
        const src = String(current.attrs['src'] ?? '')
        const url = src.toLowerCase().startsWith('cid:') ? storage.urls.get(src.slice(4)) : src
        if (url) img.src = url
        else img.removeAttribute('src')
        img.dataset['loading'] = url ? 'false' : 'true'
        img.alt = String(current.attrs['alt'] ?? '')
      }
      draw()
      storage.listeners.add(draw)
      return {
        dom: img,
        update(next) {
          if (next.type !== current.type) return false
          current = next
          draw()
          return true
        },
        destroy() {
          storage.listeners.delete(draw)
        },
      }
    }
  },
})

/** Makes a picture drawable in every node that refers to it. */
export function setInlineImageUrl(storage: InlineImageStorage, cid: string, url: string): void {
  storage.urls.set(cid, url)
  for (const redraw of storage.listeners) redraw()
}

export function inlineImageStorage(editor: Editor): InlineImageStorage {
  return (editor.storage as unknown as { inlineImage: InlineImageStorage }).inlineImage
}
