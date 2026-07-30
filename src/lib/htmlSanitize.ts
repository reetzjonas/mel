import DOMPurify from 'dompurify'

/**
 * Sanitize an HTML mail body for display inside a sandboxed iframe.
 * Scripts/forms are stripped; remote content stays (image blocking with
 * per-sender allow comes in Phase 2).
 */
export function sanitizeMailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['form', 'input', 'button', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['onerror', 'onload'],
  })
}

const FRAME_CSS = `
  :root { color-scheme: light dark; }
  body { margin: 12px; font: 14px/1.5 system-ui, sans-serif; overflow-wrap: break-word; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; }
  blockquote { border-left: 3px solid #8884; margin-left: 0; padding-left: 12px; color: #666; }
`

/** Full srcdoc document for the reading-pane iframe. */
export function mailFrameDoc(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data: cid:; style-src 'unsafe-inline'">
<base target="_blank">
<style>${FRAME_CSS}</style></head><body>${sanitizeMailHtml(html)}</body></html>`
}

export function textFrameDoc(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return mailFrameDoc(`<pre>${escaped}</pre>`)
}
