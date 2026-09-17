/**
 * Hand a blob to the browser as a download.
 *
 * An anchor with `download` rather than navigating to the object URL: a
 * navigation shows the file instead of saving it for anything the browser can
 * render, and loses the name entirely.
 *
 * The URL is revoked on a timer, not straight away — the click only *starts*
 * the download, and revoking while it is still being read cancels it. A minute
 * is long past the point where anything is still reading and short enough that
 * a session does not accumulate blobs it will never use again.
 */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
