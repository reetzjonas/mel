import { useState } from 'react'
import { useUi } from '../../app/store'
import { parseMailto, type Unsubscribe } from '../../domain/unsubscribe'
import { t } from '../../lib/i18n'
import { oneClickUnsubscribe } from '../../services/unsubscribe'
import { Icon } from '../../ui/Icon'
import { useCanSend } from './hooks'

/**
 * The way out of a mailing list, offered only when the message carries one.
 *
 * Above the body rather than in the toolbar: unsubscribing is a rare, final
 * act that belongs next to the newsletter it is about, not beside the buttons
 * pressed on every message.
 */
export function UnsubscribeBar({ unsubscribe }: { unsubscribe: Unsubscribe }) {
  const { openCompose, showSnackbar } = useUi()
  const canSend = useCanSend()
  const [busy, setBusy] = useState(false)
  const link = unsubscribe.https[0]
  const mailto = unsubscribe.mailto[0]

  /*
   * One-click when the sender promised to take it, and it is the only path
   * that finishes without leaving the app. What it cannot do is confirm: the
   * response is opaque without CORS (see oneClickUnsubscribe), so the
   * snackbar says the request went out and nothing more. Claiming success we
   * cannot see would be worse than saying less.
   */
  const oneClick = () => {
    if (!link) return
    setBusy(true)
    void oneClickUnsubscribe(link)
      .then((sent) => {
        showSnackbar(
          sent
            ? { message: t('unsub.sent') }
            : { message: t('unsub.failed'), actionLabel: t('unsub.open'), action: open },
        )
      })
      .finally(() => setBusy(false))
  }

  const open = () => {
    if (link) window.open(link, '_blank', 'noopener,noreferrer')
  }

  // The list wants a mail from the address it knows, and this is the mail
  // client that has it — so the composer, not the operating system's handler.
  const write = () => {
    const fields = mailto ? parseMailto(mailto) : null
    if (!fields) return
    openCompose({
      to: [{ name: null, email: fields.to }],
      subject: fields.subject,
      bodyHtml: fields.body ? `<p>${fields.body}</p>` : undefined,
    })
  }

  /*
   * A message offering only a mailto: on a server that cannot send leaves
   * nothing to press. Saying "this is a mailing list" and then offering no
   * way off it is worse than staying quiet, so the bar goes entirely.
   */
  if (!link && !(mailto && canSend)) return null

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-xs text-ink-muted">
      <Icon name="mailUnread" size={13} className="shrink-0" />
      <span className="min-w-0 flex-1">{t('unsub.notice')}</span>
      {unsubscribe.oneClick && link && (
        <button
          type="button"
          disabled={busy}
          onClick={oneClick}
          className="shrink-0 font-medium text-accent hover:underline disabled:opacity-50"
        >
          {busy ? t('unsub.sending') : t('unsub.action')}
        </button>
      )}
      {!unsubscribe.oneClick && link && (
        <button
          type="button"
          onClick={open}
          className="shrink-0 font-medium text-accent hover:underline"
        >
          {t('unsub.open')}
        </button>
      )}
      {/* Only worth offering if this server can actually send the mail. */}
      {!link && mailto && canSend && (
        <button
          type="button"
          onClick={write}
          className="shrink-0 font-medium text-accent hover:underline"
        >
          {t('unsub.write')}
        </button>
      )}
    </div>
  )
}
