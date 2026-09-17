/**
 * Handing a file to another app (Web Share API).
 *
 * The share sheet is a phone and tablet affair — Chrome on Android, Safari on
 * iOS and macOS, Chrome on Windows. Everywhere else `navigator.share` is
 * simply absent, so the caller keeps its download button as the way out and
 * only offers this in addition.
 */

/** Whether offering a share at all makes sense; the file is checked at share time. */
export function canShareFiles(): boolean {
  return 'share' in navigator && 'canShare' in navigator
}

/**
 * True when the file went to the share sheet, false when it has to be saved
 * instead — because the platform refused this particular file, or the API is
 * not there at all.
 *
 * Someone dismissing the sheet counts as handled: they saw the choice and
 * chose nothing, and popping a download at them afterwards is not what they
 * asked for.
 */
export async function shareFile(blob: Blob, name: string): Promise<boolean> {
  if (!canShareFiles()) return false
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' })
  if (!navigator.canShare({ files: [file] })) return false
  try {
    await navigator.share({ files: [file] })
  } catch {
    /* dismissed, or the target app refused it */
  }
  return true
}
