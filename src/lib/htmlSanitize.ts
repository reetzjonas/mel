import DOMPurify from 'dompurify'

/**
 * Sanitize an HTML mail body for display inside a sandboxed iframe.
 * Scripts and forms are stripped; whether remote content may load is decided
 * by the frame's Content-Security-Policy, not here — see mailFrameDoc.
 */
export function sanitizeMailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['form', 'input', 'button', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['onerror', 'onload'],
  })
}

const BASE_CSS = `
  body { margin: 14px 16px; font: 14px/1.6 'Inter Variable', ui-sans-serif, system-ui, sans-serif; overflow-wrap: break-word; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; font: inherit; margin: 0; }
  blockquote { border-left: 3px solid #8884; margin-left: 0; padding-left: 12px; color: #666; }
`

/*
 * Remote images are the tracking surface of email: a unique URL per recipient
 * turns opening a message into a read receipt, and leaks the IP and rough
 * time. Blocking is done in the frame's CSP rather than by rewriting the
 * markup, because the CSP also covers what markup rewriting misses — CSS
 * `background-image`, `srcset`, `<picture>` sources.
 *
 * `data:` and `cid:` stay allowed: those are carried inside the message
 * itself, so they reveal nothing to the sender.
 */
function frameDoc(body: string, css: string, allowRemote: boolean): string {
  const imgSrc = allowRemote ? 'http: https: data: cid:' : 'data: cid:'
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'">
<base target="_blank">
<style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`
}

/**
 * Whether the message would reach out to the network when displayed.
 *
 * Deliberately generous about what counts: anything pointing at http(s) in an
 * attribute or a CSS url(). Over-reporting only shows a banner that turns out
 * to change nothing; under-reporting would let content load with no way to
 * tell it happened.
 */
export function hasRemoteContent(html: string): boolean {
  return /(?:src|srcset|background|poster)\s*=\s*["']?\s*https?:/i.test(html)
    || /url\(\s*["']?\s*https?:/i.test(html)
}

/**
 * Real HTML mail: rendered on white regardless of app theme. Senders hardcode
 * dark text and assume a light canvas, so theming it would break contrast.
 */
export function mailFrameDoc(html: string, allowRemote = false): string {
  return frameDoc(
    sanitizeMailHtml(html),
    ':root { color-scheme: light; background: #fff; }',
    allowRemote,
  )
}

/**
 * Plain-text mail: we author this markup ourselves, so it can follow the app
 * theme instead of punching a white rectangle into a dark reading pane.
 * Colors are passed in as literals because the iframe has no access to the
 * parent document's custom properties.
 */
export function textFrameDoc(text: string, theme: { fg: string; bg: string }): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return frameDoc(
    `<pre>${escaped}</pre>`,
    `:root { color-scheme: ${theme.bg === '#ffffff' ? 'light' : 'dark'}; }
     body { background: ${theme.bg}; color: ${theme.fg}; }`,
    // Plain text cannot reference anything remote in the first place.
    false,
  )
}
