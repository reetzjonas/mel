import { Link, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useUi } from '../../app/store'
import type { FileNode } from '../../domain/file'
import { formatBytes } from '../../lib/bytes'
import { t } from '../../lib/i18n'
import {
  createFolder,
  deleteNodes,
  renameNode,
  uploadFiles,
} from '../../services/files'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { NameDialog } from '../../ui/NameDialog'
import { Tooltip } from '../../ui/Tooltip'
import { primaryButtonClass, secondaryButtonClass } from '../../ui/styles'
import { FilePreview } from './FilePreview'
import { useFilePath, useFolderChildren } from './hooks'

type Dialog = { kind: 'newFolder' } | { kind: 'rename'; node: FileNode }

export function FileBrowser({
  accountId,
  folderId,
}: {
  accountId: string
  folderId: string | null
}) {
  const children = useFolderChildren(accountId, folderId)
  const trail = useFilePath(accountId, folderId)
  const navigate = useNavigate()
  const { showSnackbar } = useUi()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [selected, setSelected] = useState<FileNode | null>(null)
  const [busy, setBusy] = useState(false)
  const [dropping, setDropping] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  const report = (err: string | null) => {
    if (err) showSnackbar({ message: err })
  }

  const run = async (op: () => Promise<string | null>) => {
    setBusy(true)
    try {
      report(await op())
    } finally {
      setBusy(false)
    }
  }

  const upload = (list: FileList | null) => {
    const picked = [...(list ?? [])]
    if (picked.length) void run(() => uploadFiles(accountId, folderId, picked))
  }

  const remove = (node: FileNode) => {
    const question =
      node.nodeType === 'directory' ? t('files.deleteFolder.confirm') : t('files.delete.confirm')
    if (!window.confirm(question)) return
    if (selected?.id === node.id) setSelected(null)
    void run(() => deleteNodes(accountId, [node.id]))
  }

  return (
    <div className="flex h-full gap-0 bg-canvas sm:gap-3 sm:p-3">
      <section
        // Below lg the preview takes the whole width, so the listing steps
        // aside instead of being squeezed next to it — the same swap the
        // contact list does, and the preview's close button comes back here.
        className={`panel h-full min-w-0 flex-1 flex-col overflow-hidden max-sm:rounded-none max-sm:shadow-none lg:flex ${
          selected ? 'hidden lg:flex' : 'flex'
        }`}
        onDragOver={(e) => {
          // Only a drag carrying actual files; a dragged link is not an upload.
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDropping(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setDropping(false)
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDropping(false)
          upload(e.dataTransfer.files)
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-2.5 py-2">
          <Breadcrumb trail={trail} />
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => setDialog({ kind: 'newFolder' })}
              className={secondaryButtonClass}
            >
              {t('files.newFolder')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => picker.current?.click()}
              className={primaryButtonClass}
            >
              {busy ? t('files.uploading') : t('files.upload')}
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              className="hidden"
              aria-label={t('files.upload')}
              onChange={(e) => {
                upload(e.target.files)
                // Same file twice in a row still has to fire a change event.
                e.target.value = ''
              }}
            />
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-y-auto">
          {dropping && (
            <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-panel border-2 border-dashed border-accent bg-accent-wash/80 text-sm font-medium text-ink">
              {t('files.dropHere')}
            </div>
          )}
          {children === undefined ? null : children.length === 0 ? (
            <EmptyState icon="folder" title={t('files.empty')} hint={t('files.emptyHint')} />
          ) : (
            <ul className="p-1.5">
              {children.map((node) => (
                <FileRow
                  key={node.id}
                  node={node}
                  selected={selected?.id === node.id}
                  busy={busy}
                  onOpen={() => {
                    if (node.nodeType === 'directory')
                      void navigate({ to: '/files/$folderId', params: { folderId: node.id } })
                    else setSelected(node)
                  }}
                  onRename={() => setDialog({ kind: 'rename', node })}
                  onDelete={() => remove(node)}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      {selected && (
        <aside className="panel flex h-full w-full shrink-0 overflow-hidden max-sm:rounded-none max-sm:shadow-none lg:w-96">
          <FilePreview
            key={selected.id}
            accountId={accountId}
            node={selected}
            onClose={() => setSelected(null)}
          />
        </aside>
      )}

      {dialog?.kind === 'newFolder' && (
        <NameDialog
          title={t('files.newFolder')}
          confirmLabel={t('files.newFolder')}
          cancelLabel={t('contacts.cancel')}
          onClose={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null)
            void run(() => createFolder(accountId, folderId, name))
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog
          title={t('files.rename')}
          initial={dialog.node.name}
          confirmLabel={t('files.rename')}
          cancelLabel={t('contacts.cancel')}
          onClose={() => setDialog(null)}
          onConfirm={(name) => {
            const id = dialog.node.id
            setDialog(null)
            void run(() => renameNode(accountId, id, name))
          }}
        />
      )}
    </div>
  )
}

function Breadcrumb({ trail }: { trail: FileNode[] | undefined }) {
  return (
    <nav className="flex min-w-0 items-center gap-1 text-sm">
      <Link
        to="/files"
        className="shrink-0 rounded-control px-1.5 py-1 font-medium text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        {t('files.root')}
      </Link>
      {(trail ?? []).map((node, i, all) => (
        <span key={node.id} className="flex min-w-0 items-center gap-1">
          <span className="text-ink-subtle">/</span>
          {i === all.length - 1 ? (
            <span className="truncate px-1.5 py-1 font-medium text-ink">{node.name}</span>
          ) : (
            <Link
              to="/files/$folderId"
              params={{ folderId: node.id }}
              className="truncate rounded-control px-1.5 py-1 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {node.name}
            </Link>
          )}
        </span>
      ))}
    </nav>
  )
}

function FileRow({
  node,
  selected,
  busy,
  onOpen,
  onRename,
  onDelete,
}: {
  node: FileNode
  selected: boolean
  busy: boolean
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const isDir = node.nodeType === 'directory'
  return (
    <li className="group flex items-center gap-1 rounded-control pr-1 transition-colors hover:bg-surface-2 data-selected:bg-accent-wash" data-selected={selected || undefined}>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left"
      >
        <Icon
          name={isDir ? 'folder' : 'file'}
          size={17}
          className={isDir ? 'shrink-0 text-accent' : 'shrink-0 text-ink-subtle'}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{node.name}</span>
          <span className="block truncate text-xs text-ink-subtle">
            {isDir ? t('files.folder') : formatBytes(node.size ?? 0)}
          </span>
        </span>
      </button>
      {/* Kept mounted rather than conditionally rendered: a row whose buttons
          appear on hover would change height as the pointer crosses it. */}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <Tooltip label={t('files.rename')}>
          <button
            type="button"
            aria-label={t('files.rename')}
            disabled={busy}
            onClick={onRename}
            className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <Icon name="compose" size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t('files.delete')}>
          <button
            type="button"
            aria-label={t('files.delete')}
            disabled={busy}
            onClick={onDelete}
            className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface hover:text-danger"
          >
            <Icon name="trash" size={14} />
          </button>
        </Tooltip>
      </span>
    </li>
  )
}
