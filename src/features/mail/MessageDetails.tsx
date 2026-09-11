import { useEffect, useRef, useState } from 'react'
import { useUi } from '../../app/store'
import { Keyword, type EmailHeader } from '../../domain/email'
import {
  authResults,
  deliveryPath,
  emlFileName,
  headerValue,
  headersAsText,
  notableHeaders,
  type MessageMetadata,
  type RawHeader,
} from '../../domain/messageMetadata'
import type { Mailbox } from '../../domain/mailbox'
import { formatBytes } from '../../lib/bytes'
import { formatFullDate } from '../../lib/dates'
import { t } from '../../lib/i18n'
import { downloadOriginal, getMessageMetadata } from '../../services/mail'
import { Icon } from '../../ui/Icon'
import { Skeleton } from '../../ui/Skeleton'
import { overlayPanelClass, secondaryButtonClass } from '../../ui/styles'

/** Above this, a value is folded away behind a toggle rather than shown whole. */
const LONG_VALUE = 200

/**
 * A header value, or any other line straight out of the message.
 *
 * Rendered as monospaced plain text that wraps mid-token, and never as a link:
 * a header holds whatever the sender wrote, including URLs that would be a
 * click away from a phishing page and 4 KB DKIM signatures that would push the
 * rest of the dialog off screen. Long ones are clamped with a toggle, so the
 * list stays readable and nothing is withheld.
 */
function Value({ text, muted }: { text: string; muted?: boolean }) {
  const [full, setFull] = useState(false)
  const long = text.length > LONG_VALUE
  return (
    <>
      <span
        className={`block font-mono text-xs break-all whitespace-pre-wrap ${
          muted ? 'text-ink-subtle' : 'text-ink'
        } ${long && !full ? 'line-clamp-3' : ''}`}
      >
        {text}
      </span>
      {long && (
        <button
          type="button"
          onClick={() => setFull(!full)}
          className="mt-0.5 text-xs font-medium text-accent hover:underline"
        >
          {full ? t('mail.details.showLess') : t('mail.details.showFull')}
        </button>
      )}
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-1">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-xs break-words">{children}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line px-5 py-3">
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-ink-muted uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

/** pass is reassuring, fail is not, and everything else states itself. */
const AUTH_TONE: Record<string, string> = {
  pass: 'text-success',
  fail: 'text-danger',
  softfail: 'text-danger',
  permerror: 'text-danger',
  temperror: 'text-danger',
}

const FLAG_LABELS: Array<[string, Parameters<typeof t>[0]]> = [
  [Keyword.flagged, 'mail.details.flagFlagged'],
  [Keyword.draft, 'mail.draft'],
  [Keyword.answered, 'mail.details.flagAnswered'],
  [Keyword.forwarded, 'mail.details.flagForwarded'],
]

function addresses(list: EmailHeader['to']): string {
  return list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')
}

/**
 * Everything the app knows about one message: what it holds locally, plus the
 * raw headers and the delivery path fetched from the server on demand.
 *
 * The local half renders immediately and works offline; only the header
 * sections wait on the network, and they say so when it fails rather than
 * leaving the dialog empty. Nothing here is a link and nothing loads remote
 * content — inspecting a suspicious message must not tell its sender anything.
 */
export function MessageDetails({
  accountId,
  email,
  mailboxes,
  onClose,
}: {
  accountId: string
  email: EmailHeader
  mailboxes: Mailbox[] | undefined
  onClose: () => void
}) {
  const [meta, setMeta] = useState<MessageMetadata | null | 'loading'>('loading')
  const { showSnackbar } = useUi()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let alive = true
    setMeta('loading')
    getMessageMetadata(accountId, email.id)
      .then((m) => alive && setMeta(m))
      .catch(() => alive && setMeta(null))
    return () => {
      alive = false
    }
  }, [accountId, email.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const headers = meta !== 'loading' && meta ? meta.headers : []
  const hops = deliveryPath(headers)
  const auth = authResults(headers)
  // Message-ID has its own row in the overview above; listing it twice makes
  // the shortcut section look like it holds something the summary did not.
  const notable = notableHeaders(headers).filter((header) => header.name !== 'Message-ID')
  const folders = Object.keys(email.mailboxIds)
    .map((id) => mailboxes?.find((m) => m.id === id)?.name ?? id)
    .join(', ')
  const flags = [
    email.keywords[Keyword.seen] ? t('mail.details.flagRead') : t('mail.details.flagUnread'),
    ...FLAG_LABELS.filter(([keyword]) => email.keywords[keyword]).map(([, key]) => t(key)),
  ].join(', ')
  // The Message-ID as the message itself carries it; the id in the URL is the
  // server's own handle for it and means nothing anywhere else.
  const messageId = headerValue(headers, 'Message-ID')

  async function copyHeaders() {
    try {
      await navigator.clipboard.writeText(headersAsText(headers))
      showSnackbar({ message: t('mail.details.copied') })
    } catch {
      // No clipboard permission, or an insecure context: the values are on
      // screen either way, so this is a dead end and not a failure to hide.
      showSnackbar({ message: t('mail.details.copyFailed') })
    }
  }

  async function saveOriginal(blobId: string) {
    try {
      await downloadOriginal(accountId, blobId, emlFileName(email.subject))
    } catch {
      showSnackbar({ message: t('mail.details.downloadFailed') })
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('mail.details')}
        className={`animate-rise flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden ${overlayPanelClass}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{t('mail.details')}</h2>
            <p className="truncate text-xs text-ink-muted">
              {email.subject || t('mail.noSubject')}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label={t('shortcuts.close')}
            onClick={onClose}
            className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Section title={t('mail.details.overview')}>
            <dl>
              <Row label={t('mail.from')}>{addresses(email.from) || t('mail.unknownSender')}</Row>
              {email.to.length > 0 && <Row label={t('mail.to')}>{addresses(email.to)}</Row>}
              {email.cc.length > 0 && <Row label={t('mail.cc')}>{addresses(email.cc)}</Row>}
              <Row label={t('mail.details.sent')}>
                {email.sentAt ? formatFullDate(email.sentAt) : '—'}
              </Row>
              <Row label={t('mail.details.received')}>{formatFullDate(email.receivedAt)}</Row>
              <Row label={t('mail.details.size')}>{formatBytes(email.size)}</Row>
              <Row label={t('mail.details.folders')}>{folders || '—'}</Row>
              <Row label={t('mail.details.flags')}>{flags}</Row>
              {messageId && (
                <Row label={t('mail.details.messageId')}>
                  <Value text={messageId} />
                </Row>
              )}
              <Row label={t('mail.details.threadId')}>
                <Value text={email.threadId} />
              </Row>
              <Row label={t('mail.details.emailId')}>
                <Value text={email.id} />
              </Row>
            </dl>
          </Section>

          {meta === 'loading' && (
            <Section title={t('mail.details.headers')}>
              <div className="animate-fade space-y-2">
                <Skeleton className="h-3 w-3/5" />
                <Skeleton className="h-3 w-4/5" />
                <Skeleton className="h-3 w-2/5" />
              </div>
            </Section>
          )}

          {meta === null && (
            <Section title={t('mail.details.headers')}>
              <p className="text-xs text-danger">{t('mail.details.loadError')}</p>
            </Section>
          )}

          {meta !== 'loading' && meta && (
            <>
              <Section title={t('mail.details.authentication')}>
                {auth.length ? (
                  /*
                   * One line per verdict, not a wrapped row: a message commonly
                   * carries two SPF results (HELO and envelope sender), and
                   * those only make sense read against the identity beside
                   * them.
                   */
                  <ul className="space-y-1">
                    {auth.map((entry) => (
                      <li
                        key={`${entry.method}=${entry.result}/${entry.identity ?? ''}`}
                        className="flex flex-wrap items-baseline gap-x-2 text-xs"
                      >
                        <span className="w-12 shrink-0 text-ink-muted">{entry.method}</span>
                        <span
                          className={`w-20 shrink-0 font-medium ${
                            AUTH_TONE[entry.result] ?? 'text-ink'
                          }`}
                        >
                          {entry.result}
                        </span>
                        {entry.identity && (
                          <span className="min-w-0 font-mono text-ink-subtle break-all">
                            {entry.identity}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-ink-muted">{t('mail.details.noAuth')}</p>
                )}
              </Section>

              {hops.length > 0 && (
                <Section title={t('mail.details.delivery')}>
                  <ol className="space-y-2">
                    {hops.map((hop, i) => (
                      <li key={i} className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                          <span className="text-ink-muted">{`${t('mail.details.hop')} ${i + 1}`}</span>
                          {hop.from && (
                            <span>
                              <span className="text-ink-muted">{t('mail.details.hopFrom')} </span>
                              {hop.from}
                              {hop.ip ? ` [${hop.ip}]` : ''}
                            </span>
                          )}
                          {hop.by && (
                            <span>
                              <span className="text-ink-muted">{t('mail.details.hopBy')} </span>
                              {hop.by}
                            </span>
                          )}
                          {hop.protocol && (
                            <span>
                              <span className="text-ink-muted">{t('mail.details.hopVia')} </span>
                              {hop.protocol}
                            </span>
                          )}
                          {hop.at && (
                            <span>
                              <span className="text-ink-muted">{t('mail.details.hopAt')} </span>
                              {hop.at}
                            </span>
                          )}
                        </div>
                        {/* The parsed line above is a reading of the raw one,
                            not a replacement: anything the regexes missed is
                            still here. */}
                        <Value text={hop.raw} muted />
                      </li>
                    ))}
                  </ol>
                </Section>
              )}

              {notable.length > 0 && (
                <Section title={t('mail.details.notable')}>
                  <dl>
                    {notable.map((header) => (
                      <Row key={header.name} label={header.name}>
                        <Value text={header.value} />
                      </Row>
                    ))}
                  </dl>
                </Section>
              )}

              <Section title={t('mail.details.headers')}>
                {headers.length ? (
                  <dl>
                    {headers.map((header: RawHeader, i) => (
                      <Row key={`${header.name}-${i}`} label={header.name}>
                        <Value text={header.value.replace(/\r?\n[ \t]+/g, ' ').trim()} />
                      </Row>
                    ))}
                  </dl>
                ) : (
                  <p className="text-xs text-ink-muted">{t('mail.details.noHeaders')}</p>
                )}
                <p className="mt-2 text-xs text-ink-subtle">{t('mail.details.hint')}</p>
              </Section>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            className={`${secondaryButtonClass} flex items-center gap-2 disabled:opacity-50`}
            disabled={headers.length === 0}
            onClick={() => void copyHeaders()}
          >
            <Icon name="copy" size={14} />
            {t('mail.details.copyHeaders')}
          </button>
          <button
            type="button"
            className={`${secondaryButtonClass} flex items-center gap-2 disabled:opacity-50`}
            disabled={meta === 'loading' || !meta?.blobId}
            onClick={() => meta !== 'loading' && meta?.blobId && void saveOriginal(meta.blobId)}
          >
            <Icon name="download" size={14} />
            {t('mail.details.downloadOriginal')}
          </button>
        </div>
      </div>
    </div>
  )
}
