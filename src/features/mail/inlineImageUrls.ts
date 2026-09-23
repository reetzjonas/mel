import { useEffect, useState } from 'react'
import type { EmailBody, EmailBodyPart } from '../../domain/email'
import { inlineParts } from '../../lib/inlineImages'
import { connectionFor } from '../../sync/connections'

function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

/**
 * `data:` URLs for the pictures a message body carries inline, or null while
 * they are still being fetched.
 *
 * `data:` rather than object URLs: the body renders in a sandboxed frame with
 * an opaque origin, which may not read a `blob:` URL this page made, and its
 * Content-Security-Policy already allows `data:` for exactly this — the bytes
 * are part of the message, so showing them tells the sender nothing.
 *
 * A picture that cannot be fetched (offline, gone from the server) is left
 * out and stays a broken image; the message is not held back for it.
 */
export function useInlineImageUrls(
  accountId: string,
  body: EmailBody | null | 'loading',
): Record<string, string> | null {
  const [resolved, setResolved] = useState<{ id: string; urls: Record<string, string> } | null>(
    null,
  )
  const current = body !== 'loading' && body ? body : null
  const parts = current ? inlineParts(current) : new Map<string, EmailBodyPart>()
  const id = current?.emailId ?? ''
  const key = [...parts.keys()].sort().join('\u0000')

  useEffect(() => {
    if (!key) return
    let alive = true
    void (async () => {
      const urls: Record<string, string> = {}
      const conn = await connectionFor(accountId).catch(() => null)
      if (conn?.mail) {
        await Promise.all(
          [...parts].map(async ([cid, part]) => {
            try {
              const blob = await conn.mail!.downloadBlob(part.blobId!, part.type, part.name ?? cid)
              urls[cid] = await asDataUrl(new Blob([blob], { type: part.type }))
            } catch {
              // Left out: a broken picture rather than a message that never shows.
            }
          }),
        )
      }
      if (alive) setResolved({ id, urls })
    })()
    return () => {
      alive = false
    }
    // `parts` is rebuilt every render; `key` and `id` are what it depends on.
    // oxlint-disable-next-line exhaustive-deps
  }, [accountId, id, key])

  if (!key) return {}
  return resolved && resolved.id === id ? resolved.urls : null
}
