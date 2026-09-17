import { useEffect, useState } from 'react'
import type { FileNode } from '../../domain/file'
import { formatBytes } from '../../lib/bytes'
import { t } from '../../lib/i18n'
import { canShareFiles, shareFile } from '../../lib/webShare'
import { downloadNode } from '../../services/files'
import { Icon } from '../../ui/Icon'
import { overlayPanelClass, secondaryButtonClass } from '../../ui/styles'

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
  const [expanded, setExpanded] = useState(false)
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

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

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

  // Falls back to saving when the platform turns this particular file down,
  // so the button always does something rather than going quiet.
  const share = async () => {
    const blob = await downloadNode(accountId, node)
    if (!blob) return
    if (!(await shareFile(blob, node.name))) await save()
  }

  // Only worth offering where there is something on screen to make bigger.
  const canExpand = content.kind === 'url' || content.kind === 'text'

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-start gap-2 border-b border-line px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">{node.name}</p>
          <p className="truncate text-xs text-ink-subtle">
            {formatBytes(node.size ?? 0)} · {type || '—'}
          </p>
        </div>
        {canExpand && (
          <button
            type="button"
            aria-label={t('files.preview.expand')}
            onClick={() => setExpanded(true)}
            className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="expand" size={15} />
          </button>
        )}
        <button
          type="button"
          aria-label={t('mail.back')}
          onClick={onClose}
          className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="close" size={15} />
        </button>
      </div>

      {/* One viewer at a time. A PDF left mounted behind the overlay would have
          the browser running two copies of the same document for no gain, and
          nothing of the pane is visible underneath anyway. */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!expanded && <PreviewBody content={content} type={type} name={node.name} />}
      </div>

      <div className="flex gap-2 border-t border-line p-3">
        <button type="button" onClick={() => void save()} className={secondaryButtonClass}>
          {t('files.download')}
        </button>
        {canShareFiles() && (
          <button type="button" onClick={() => void share()} className={secondaryButtonClass}>
            {t('files.share')}
          </button>
        )}
      </div>

      {expanded && (
        <div
          className="animate-fade fixed inset-0 z-50 flex flex-col bg-black/50 p-2 backdrop-blur-[2px] sm:p-6"
          onClick={() => setExpanded(false)}
        >
          <div
            className={`animate-rise flex min-h-0 w-full flex-1 flex-col ${overlayPanelClass}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
              <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                {node.name}
              </p>
              <button
                type="button"
                autoFocus
                aria-label={t('files.preview.collapse')}
                onClick={() => setExpanded(false)}
                className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <Icon name="close" size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <PreviewBody full content={content} type={type} name={node.name} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The file itself, at panel width or filling the window.
 *
 * `full` is not a different renderer, only different bounds: a PDF and a text
 * file simply take the space they are given, and an image stops growing at the
 * height of the viewport instead of scrolling off the bottom of it.
 */
function PreviewBody({
  content,
  type,
  name,
  full = false,
}: {
  content: Content
  type: string
  name: string
  full?: boolean
}) {
  return (
    <>
      {content.kind === 'loading' && (
        <p className="text-xs text-ink-subtle">{t('files.loading')}</p>
      )}
      {content.kind === 'text' && (
        <pre className={`whitespace-pre-wrap text-ink-muted ${full ? 'text-[13px]' : 'text-xs'}`}>
          {content.text}
        </pre>
      )}
      {content.kind === 'url' && IMAGE.test(type) && (
        <img
          src={content.url}
          alt={name}
          className={
            full
              ? 'mx-auto max-h-full max-w-full rounded-control object-contain'
              : 'max-w-full rounded-control'
          }
        />
      )}
      {content.kind === 'url' && PDF.test(type) && (
        <embed
          src={content.url}
          type={type}
          className={`w-full rounded-control ${full ? 'h-full' : 'h-full min-h-96'}`}
        />
      )}
      {content.kind === 'none' && (
        <p className="text-xs text-ink-subtle">{t('files.preview.none')}</p>
      )}
    </>
  )
}
