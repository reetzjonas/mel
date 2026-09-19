import { useRef, useState } from 'react'
import { attachmentsOf, newLinkId, withLink, withoutLink } from '../../lib/attachments'
import type { EventLinks } from '../../domain/calendar'
import { formatBytes } from '../../lib/bytes'
import { t } from '../../lib/i18n'
import { embedFile, referenceFile, saveAttachment } from '../../services/eventAttachments'
import { Icon } from '../../ui/Icon'
import { Tooltip } from '../../ui/Tooltip'
import { secondaryButtonClass } from '../../ui/styles'
import { FilePicker } from '../files/FilePicker'

const rowButton =
  'min-w-0 flex-1 truncate text-left text-sm text-ink hover:text-accent hover:underline'

/**
 * The files attached to an event: a list that opens and, when editable, adds
 * and removes. Only the `enclosure` links are shown; every other entry of the
 * map is passed through untouched (see `lib/attachments.ts`).
 */
export function EventAttachments({
  links,
  accountId,
  canUseFiles,
  readOnly = false,
  onChange,
  onPicking,
}: {
  links: EventLinks | undefined
  accountId: string
  /** Whether the account has Files to attach from. */
  canUseFiles: boolean
  readOnly?: boolean
  onChange?: (next: EventLinks) => void
  /** Told when the file picker opens or closes, so the dialog under it can stand down. */
  onPicking?: (open: boolean) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const list = attachmentsOf(links)

  function pick(open: boolean) {
    setPicking(open)
    onPicking?.(open)
  }

  async function fromDevice(files: FileList | null) {
    setError(null)
    let next = links
    for (const file of Array.from(files ?? [])) {
      const link = await embedFile(file)
      if (!link) {
        setError(t('cal.attach.tooLarge'))
        continue
      }
      next = withLink(next, newLinkId(next), link)
    }
    if (next !== links) onChange?.(next ?? {})
  }

  async function open(id: string) {
    const a = list.find((x) => x.id === id)
    if (!a) return
    setError(null)
    if (!(await saveAttachment(accountId, a))) setError(t('cal.attach.failed'))
  }

  if (list.length === 0 && readOnly) return null

  return (
    <div className="space-y-2">
      {list.length > 0 && (
        <ul className="space-y-1">
          {list.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-sm">
              <Icon name="paperclip" size={13} className="shrink-0 text-ink-muted" />
              {a.source === 'web' ? (
                <a href={a.href} target="_blank" rel="noopener noreferrer" className={rowButton}>
                  {a.name}
                </a>
              ) : (
                <button type="button" onClick={() => void open(a.id)} className={rowButton}>
                  {a.name}
                </button>
              )}
              {a.size !== null && (
                <span className="shrink-0 text-xs text-ink-subtle">{formatBytes(a.size)}</span>
              )}
              {!readOnly && (
                <Tooltip label={t('cal.attach.remove')}>
                  <button
                    type="button"
                    aria-label={`${t('cal.attach.remove')}: ${a.name}`}
                    onClick={() => onChange?.(withoutLink(links, a.id))}
                    className="shrink-0 text-ink-muted hover:text-danger"
                  >
                    <Icon name="close" size={13} />
                  </button>
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={`${secondaryButtonClass} px-3 py-1.5`}
            onClick={() => input.current?.click()}
          >
            {t('cal.attach.device')}
          </button>
          {canUseFiles && (
            <button
              type="button"
              className={`${secondaryButtonClass} px-3 py-1.5`}
              onClick={() => pick(true)}
            >
              {t('cal.attach.files')}
            </button>
          )}
          <input
            ref={input}
            type="file"
            multiple
            hidden
            data-testid="event-attachment-input"
            onChange={(e) => {
              void fromDevice(e.target.files)
              e.target.value = ''
            }}
          />
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      {picking && (
        <FilePicker
          accountId={accountId}
          onClose={() => pick(false)}
          onPick={(node) => {
            pick(false)
            void referenceFile(accountId, node).then((link) => {
              if (!link) return setError(t('cal.attach.failed'))
              onChange?.(withLink(links, newLinkId(links), link))
            })
          }}
        />
      )}
    </div>
  )
}
