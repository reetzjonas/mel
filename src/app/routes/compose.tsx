import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { EmailAddress } from '../../domain/email'
import { parseMailto, textToHtml } from '../../lib/mailto'
import type { ComposeInit } from '../store'
import { useUi } from '../store'

export const Route = createFileRoute('/compose')({
  component: ComposeEntry,
})

interface ComposeSearch {
  /** The whole `mailto:` URL, from the OS protocol handler. */
  mailto?: string
  /** Web Share Target: the manifest maps the shared title/text/url here. */
  subject?: string
  body?: string
  url?: string
  to?: string
}

function address(email: string): EmailAddress {
  return { name: null, email }
}

function initFrom(search: ComposeSearch): ComposeInit {
  const mailto = search.mailto ? parseMailto(search.mailto) : null
  if (mailto) {
    return {
      to: mailto.to.map(address),
      cc: mailto.cc.map(address),
      bcc: mailto.bcc.map(address),
      subject: mailto.subject,
      bodyHtml: textToHtml(mailto.body),
    }
  }
  // A share carries the text and the link separately, and plenty of apps send
  // both — the page's own blurb and its address. Neither is worth dropping.
  const body = [search.body, search.url].filter(Boolean).join('\n\n')
  return {
    to: (search.to ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .map(address),
    subject: search.subject ?? '',
    bodyHtml: textToHtml(body),
  }
}

/**
 * Where the rest of the system writes mail: the OS `mailto:` handler and the
 * share sheet both land here (see the manifest in vite.config.ts).
 *
 * Not a screen — it opens the composer the shell already mounts and replaces
 * itself with `/mail` straight away. `replace` on purpose: the handover
 * carried an address and a subject, which has no business sitting in the
 * history for Back to return to, and the composer's own state was
 * deliberately kept out of the URL everywhere else too.
 */
function ComposeEntry() {
  const search = useSearch({ strict: false }) as ComposeSearch
  const openCompose = useUi((s) => s.openCompose)
  const navigate = useNavigate()

  useEffect(() => {
    openCompose(initFrom(search))
    void navigate({ to: '/mail', replace: true })
    // Once, for whatever the app was opened with — a re-run would reopen the
    // composer over whatever the user has since typed.
    // oxlint-disable-next-line exhaustive-deps
  }, [])

  return null
}
