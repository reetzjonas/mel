/*
 * Turning a picked image file into something a contact card can hold.
 *
 * The card stores the picture as a URI and nothing else — Stalwart answers
 * "blobIds in media is not supported" — so whatever is chosen travels inline,
 * inside the card, through every sync and into IndexedDB. A phone camera's
 * 4 MB JPEG would be carried around forever by a row built for names and
 * addresses, so it is scaled down to something an avatar actually needs.
 */

/** Long edge in pixels. An avatar is never rendered above 56px. */
export const MAX_EDGE = 256
const TYPE = 'image/jpeg'
const QUALITY = 0.82

/**
 * The box to draw into, keeping the aspect ratio and never scaling up.
 *
 * Pure, so the arithmetic is testable without a canvas.
 */
export function photoBox(
  width: number,
  height: number,
  maxEdge = MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (!longest) return { width: 0, height: 0 }
  const scale = Math.min(1, maxEdge / longest)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Scale a picked image down and return it as a `data:` URI. */
export async function toPhotoUri(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const box = photoBox(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = box.width
    canvas.height = box.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0, box.width, box.height)
    return canvas.toDataURL(TYPE, QUALITY)
  } finally {
    bitmap.close()
  }
}
