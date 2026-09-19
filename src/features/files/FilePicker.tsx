import { useRef, useState } from 'react'
import type { FileNode } from '../../domain/file'
import { formatBytes } from '../../lib/bytes'
import { t } from '../../lib/i18n'
import { DialogHeader } from '../../ui/DialogHeader'
import { Icon } from '../../ui/Icon'
import { modalPanelClass, modalScrimClass } from '../../ui/styles'
import { useMobileViewport, useModal } from '../../ui/useModal'
import { useFilePath, useFolderChildren } from './hooks'
import { nodeIcon, nodeLabel } from './nodePresentation'
import { isHidden } from './tree'

/**
 * Pick one file out of Files: folders open, files are chosen.
 *
 * Reads the local mirror like the browser does, so it works offline and needs
 * no request of its own. Hidden entries (`.mel/`, dotfiles) are left out, as
 * they are in the browser by default — nobody attaches those by hand.
 */
export function FilePicker({
  accountId,
  onPick,
  onClose,
}: {
  accountId: string
  onPick: (node: FileNode) => void
  onClose: () => void
}) {
  const [folderId, setFolderId] = useState<string | null>(null)
  const children = useFolderChildren(accountId, folderId)
  const trail = useFilePath(accountId, folderId)
  const panel = useRef<HTMLDivElement>(null)
  const mobileViewport = useMobileViewport()
  useModal({ panel, onClose })

  const parent = trail && trail.length > 1 ? trail[trail.length - 2]!.id : null
  const shown = (children ?? []).filter(
    (n) => !isHidden(n) && (n.nodeType === 'directory' || n.nodeType === 'file'),
  )

  return (
    <div
      className={modalScrimClass}
      style={mobileViewport ? { bottom: mobileViewport.inset } : undefined}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('files.pick.title')}
        className={`${modalPanelClass} max-h-[70vh] max-w-md max-sm:max-h-[92dvh] max-sm:rounded-t-panel`}
        style={mobileViewport ? { maxHeight: `${mobileViewport.height - 32}px` } : undefined}
      >
        <DialogHeader
          title={
            trail && trail.length > 0 ? nodeLabel(trail[trail.length - 1]!) : t('files.pick.title')
          }
          closeLabel={t('cal.cancel')}
          onClose={onClose}
        />
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-3">
          {folderId !== null && (
            <li>
              <button
                type="button"
                onClick={() => setFolderId(parent)}
                className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <Icon name="back" size={15} className="shrink-0" />
                <span className="truncate">{t('files.pick.up')}</span>
              </button>
            </li>
          )}
          {shown.map((node) => {
            const folder = node.nodeType === 'directory'
            return (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => (folder ? setFolderId(node.id) : onPick(node))}
                  className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-sm transition-colors hover:bg-surface-2"
                >
                  <Icon
                    name={nodeIcon(node)}
                    size={15}
                    className={`shrink-0 ${folder ? 'text-accent' : 'text-ink-muted'}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{nodeLabel(node)}</span>
                  {!folder && node.size !== null && (
                    <span className="shrink-0 text-xs text-ink-subtle">
                      {formatBytes(node.size)}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
          {children !== undefined && shown.length === 0 && (
            <li className="px-2 py-3 text-xs text-ink-subtle">{t('files.pick.empty')}</li>
          )}
        </ul>
      </div>
    </div>
  )
}
