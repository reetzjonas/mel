import { useEffect, useState } from 'react'
import type { FileNode } from '../../domain/file'
import { formatBytes } from '../../lib/bytes'
import { t } from '../../lib/i18n'
import { downloadNode } from '../../services/files'
import { Icon } from '../../ui/Icon'
import { secondaryButtonClass } from '../../ui/styles'

/** Types a browser can show inline; everything else is offered as a download. */
const IMAGE = /^image\//
const TEXT = /^(text\/|application\/(json|xml|javascript))/
const PDF = /^application\/pdf$/

type Content =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'url'; url: string }
  | { kind: 'text'; text: string }

export function FilePreview({
  accountId,
  node,
  onClose,
}: {
  accountId: string
  node: FileNode
  onClose: () => void
}) {
  const [content, setContent] = useState<Content>({ kind: 'loading' })
  const type = node.type ?? ''

  // No reset of `content` in here: the pane is keyed on the node, so switching
  // files remounts it and the state starts at 'loading' structurally. Resetting
  // it inside the effect instead would render the previous file's content once
  // more against the new file's name.
  useEffect(() => {
    let url: string | null = null
    let cancelled = false

    const load = async () => {
      if (!IMAGE.test(type) && !TEXT.test(type) && !PDF.test(type)) {
        setContent({ kind: 'none' })
        return
      }
      const blob = await downloadNode(accountId, node)
      if (cancelled || !blob) return
      if (TEXT.test(type)) {
        setContent({ kind: 'text', text: await blob.text() })
        return
      }
      // Re-wrapped with the declared type, so the browser renders it instead
      // of treating it as an unknown download.
      url = URL.createObjectURL(new Blob([blob], { type }))
      setContent({ kind: 'url', url })
    }
    void load().catch(() => {
      if (!cancelled) setContent({ kind: 'none' })
    })

    return () => {
      cancelled = true
      // Revoked on the way out rather than on a timer: the pane owns this URL
      // and nothing outside it can still be holding the blob.
      if (url) URL.revokeObjectURL(url)
    }
  }, [accountId, node, type])

  const save = async () => {
    const blob = await downloadNode(accountId, node)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = node.name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-start gap-2 border-b border-line px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">{node.name}</p>
          <p className="truncate text-xs text-ink-subtle">
            {formatBytes(node.size ?? 0)} · {type || '—'}
          </p>
        </div>
        <button
          type="button"
          aria-label={t('mail.back')}
          onClick={onClose}
          className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {content.kind === 'loading' && <p className="text-xs text-ink-subtle">{t('files.loading')}</p>}
        {content.kind === 'text' && (
          <pre className="text-xs whitespace-pre-wrap text-ink-muted">{content.text}</pre>
        )}
        {content.kind === 'url' && IMAGE.test(type) && (
          <img src={content.url} alt={node.name} className="max-w-full rounded-control" />
        )}
        {content.kind === 'url' && PDF.test(type) && (
          <embed src={content.url} type={type} className="h-full min-h-96 w-full rounded-control" />
        )}
        {content.kind === 'none' && (
          <p className="text-xs text-ink-subtle">{t('files.preview.none')}</p>
        )}
      </div>

      <div className="border-t border-line p-3">
        <button type="button" onClick={() => void save()} className={secondaryButtonClass}>
          {t('files.download')}
        </button>
      </div>
    </div>
  )
}
