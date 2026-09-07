/**
 * Strip stylesheet debris out of a message preview.
 *
 * The `preview` a JMAP server derives from an HTML part frequently starts with
 * whatever sat in the mail's inline `<style>`, so the list shows
 * "html, body, * { -webkit-text-size-adjust: none; …" instead of the message.
 * Previews are also truncated, so the leaking block is usually left *unclosed*
 * — that trailing fragment has to go too, or nothing is gained.
 *
 * Only blocks that actually look like declarations (`prop: value`) are removed,
 * so ordinary prose with braces ("Hi {name}") survives.
 */
export function cleanPreview(text: string): string {
  let out = text.replace(/<!--[\s\S]*?-->/g, ' ')

  // Innermost-first, repeatedly: nested at-rules need more than one pass.
  for (let i = 0; i < 4; i++) {
    const next = out
      .replace(/[^{}]*\{[^{}]*:[^{}]*\}/g, ' ')
      .replace(/[^{}]*\{\s*\}/g, ' ')
    if (next === out) break
    out = next
  }

  // A rule the preview was cut off in the middle of.
  const open = out.lastIndexOf('{')
  if (open !== -1 && !out.includes('}', open) && out.includes(':', open)) {
    const selector = out.lastIndexOf('}', open)
    out = out.slice(0, selector === -1 ? 0 : selector + 1)
  }

  return out.replace(/\s+/g, ' ').trim()
}
