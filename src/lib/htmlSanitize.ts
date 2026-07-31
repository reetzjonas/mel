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

const BASE_CSS = `
  body { margin: 14px 16px; font: 14px/1.6 'Inter Variable', ui-sans-serif, system-ui, sans-serif; overflow-wrap: break-word; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; font: inherit; margin: 0; }
  blockquote { border-left: 3px solid #8884; margin-left: 0; padding-left: 12px; color: #666; }
`

function frameDoc(body: string, css: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data: cid:; style-src 'unsafe-inline'">
<base target="_blank">
<style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`
}

/**
 * Real HTML mail: rendered on white regardless of app theme. Senders hardcode
 * dark text and assume a light canvas, so theming it would break contrast.
 */
export function mailFrameDoc(html: string): string {
  return frameDoc(sanitizeMailHtml(html), ':root { color-scheme: light; background: #fff; }')
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
  )
}
