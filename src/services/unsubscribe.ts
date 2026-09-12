/**
 * One-click unsubscribe (RFC 8058).
 *
 * The request is a form POST carrying exactly `List-Unsubscribe=One-Click`,
 * which the sender has promised to accept. Two things follow from having no
 * backend to send it through:
 *
 * 1. `mode: 'no-cors'`. The list's server has no reason to allow this origin,
 *    and without CORS headers the browser refuses to *read* the response. It
 *    will still send the request, so the unsubscribe does happen — the answer
 *    is simply opaque to us. A form-encoded POST is a "simple request", so it
 *    goes out without a preflight the other end would have to answer.
 *
 * 2. We therefore cannot tell honoured from refused, only "left the browser"
 *    from "did not". The caller must not promise more than that, which is why
 *    this returns whether it was *sent* rather than whether it worked.
 *
 * No credentials, no referrer: the address is already in the URL the sender
 * chose, and nothing else about the reader is theirs to learn.
 */
export async function oneClickUnsubscribe(url: string): Promise<boolean> {
  if (!/^https:\/\//i.test(url)) return false
  try {
    await fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    })
    return true
  } catch {
    // Offline, DNS failure, a server that is simply gone. The link is still
    // there to open by hand, which is what the caller offers next.
    return false
  }
}
