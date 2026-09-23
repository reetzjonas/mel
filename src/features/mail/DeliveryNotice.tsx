import { useEffect } from 'react'
import type { RecipientStatus } from '../../domain/submission'
import { t } from '../../lib/i18n'
import { markFailuresSeen } from '../../services/deliveryAlerts'
import { Icon } from '../../ui/Icon'
import { useDeliveryProblems } from './hooks'

/*
 * What became of a sent message, where it did not simply go out (issue #70).
 * Silent otherwise: every message in Sent carries a submission, and a band
 * saying "sent" on each of them would only teach the eye to skip it.
 */
export function DeliveryNotice({ accountId, emailId }: { accountId: string; emailId: string }) {
  const problems = useDeliveryProblems(accountId, emailId)
  const refused = Boolean(problems?.failed.length)
  // Shown is seen: the mark on the Sent folder has done its job.
  useEffect(() => {
    if (refused) void markFailuresSeen(accountId, emailId).catch(() => {})
  }, [refused, accountId, emailId])
  if (!problems) return null
  return (
    <>
      {problems.failed.length > 0 && (
        <Band
          tone="danger"
          title={t('mail.notDelivered')}
          hint={t('mail.notDeliveredHint')}
          recipients={problems.failed}
        />
      )}
      {problems.delayed.length > 0 && (
        <Band
          tone="honey"
          title={t('mail.deliveryDelayed')}
          hint={t('mail.deliveryDelayedHint')}
          recipients={problems.delayed}
        />
      )}
    </>
  )
}

function Band({
  tone,
  title,
  hint,
  recipients,
}: {
  tone: 'danger' | 'honey'
  title: string
  hint: string
  recipients: RecipientStatus[]
}) {
  return (
    <div
      role="status"
      className={`flex gap-2 border-t border-line px-4 py-2 text-sm lg:px-6 ${
        tone === 'danger' ? 'bg-danger-wash text-danger' : 'bg-honey/10 text-ink'
      }`}
    >
      <Icon
        name="warning"
        size={14}
        className={`mt-0.5 shrink-0 ${tone === 'honey' ? 'text-honey' : ''}`}
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <ul className="mt-0.5 space-y-0.5">
          {recipients.map((r) => (
            <li key={r.email} className="min-w-0 break-words">
              <span className="font-medium">{r.email}</span>
              {/* The server's own words: "mailbox does not exist" tells the
                  sender what to fix, a generic "failed" does not. */}
              {r.smtpReply && <span className="ml-2 text-xs opacity-80">{r.smtpReply}</span>}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs opacity-80">{hint}</p>
      </div>
    </div>
  )
}
