import { Link, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useUi } from '../../app/store'
import type { FileNode } from '../../domain/file'
import { formatBytes } from '../../lib/bytes'
import { t } from '../../lib/i18n'
import { createFolder, deleteNodes, moveNodes, renameNode, uploadFiles } from '../../services/files'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { NameDialog } from '../../ui/NameDialog'
import { Tooltip } from '../../ui/Tooltip'
import { overlayPanelClass, primaryButtonClass, secondaryButtonClass } from '../../ui/styles'
import {
  clearDragState,
  draggableTouchClass,
  dragKind,
  readFileNodeDrag,
  setFileNodeDrag,
  suppressContextMenu,
} from '../mail/dragAndDrop'
import { FilePreview } from './FilePreview'
import { useAllNodes, useFilePath, useFolderChildren } from './hooks'
import { moveTargets } from './tree'

type Dialog = { kind: 'newFolder' } | { kind: 'rename'; node: FileNode } | { kind: 'move' }

export function FileBrowser({
  accountId,
  folderId,
}: {
  accountId: string
  folderId: string | null
}) {
  const children = useFolderChildren(accountId, folderId)
  const trail = useFilePath(accountId, folderId)
  const allNodes = useAllNodes(accountId)
  const navigate = useNavigate()
  const { showSnackbar } = useUi()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [preview, setPreview] = useState<FileNode | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  /**
   * Whether the checkboxes are on show.
   *
   * On a desktop the pointer reveals one per row, but touch has no hover, so
   * without a way to turn them on there is no way to select anything at all
   * with a finger.
   */
  const [selecting, setSelecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  /*
   * What is in flight, as a ref rather than state. A touch-started drag can
   * fire dragenter on the first element under the finger before any render
   * commits, so a useState value would still read as empty for the whole
   * gesture and nothing would ever highlight — the trap written up in
   * docs/notes/drag-and-drop.md.
   */
  const draggingRef = useRef<string[]>([])

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

  /**
   * Where a shift-click measures from: the last row ticked on its own.
   *
   * A ref, not state — nothing renders from it, and reading a stale value
   * would silently select the wrong range.
   */
  const anchor = useRef<string | null>(null)

  const toggle = (id: string, extend: boolean) => {
    const rows = children ?? []
    const from = rows.findIndex((n) => n.id === anchor.current)
    const to = rows.findIndex((n) => n.id === id)
    if (extend && from !== -1 && to !== -1) {
      // Shift-click adds the run between the two, as a file manager does. It
      // only ever adds: turning the range off again would undo ticks the run
      // happens to cross that were made deliberately.
      const [lo, hi] = from < to ? [from, to] : [to, from]
      setChecked((prev) => new Set([...prev, ...rows.slice(lo, hi + 1).map((n) => n.id)]))
      return
    }
    anchor.current = id
    setChecked((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const clearChecked = () => {
    setChecked(new Set())
    setSelecting(false)
    anchor.current = null
  }

  /** A dragged row that is itself checked stands in for the whole selection. */
  const dragPayload = (node: FileNode) => (checked.has(node.id) ? [...checked] : [node.id])

  const move = async (ids: string[], parentId: string | null) => {
    clearChecked()
    setDropTarget(null)
    await run(() => moveNodes(accountId, ids, parentId))
  }

  const removeChecked = () => {
    if (!window.confirm(t('files.delete.selection'))) return
    const ids = [...checked]
    clearChecked()
    if (preview && ids.includes(preview.id)) setPreview(null)
    void run(() => deleteNodes(accountId, ids))
  }

  const removeOne = (node: FileNode) => {
    const question =
      node.nodeType === 'directory' ? t('files.deleteFolder.confirm') : t('files.delete.confirm')
    if (!window.confirm(question)) return
    if (preview?.id === node.id) setPreview(null)
    void run(() => deleteNodes(accountId, [node.id]))
  }

  /** Accept a node drop onto a folder, unless it is one of the nodes in flight. */
  const folderTakesDrop = (id: string) => !draggingRef.current.includes(id)

  /*
   * The previewed node as the listing currently has it, not as it was when it
   * was clicked. The pane can change the node itself — the executable bit —
   * and a snapshot taken on click would go on showing the old value after the
   * write came back.
   */
  const previewLive = preview ? children?.find((n) => n.id === preview.id) : undefined

  return (
    <div className="flex h-full gap-0 bg-canvas sm:gap-3 sm:p-3">
      <section
        // Below lg the preview takes the whole width, so the listing steps
        // aside instead of being squeezed next to it — the same swap the
        // contact list does, and the preview's close button comes back here.
        className={`panel h-full min-w-0 flex-1 flex-col overflow-hidden max-sm:rounded-none max-sm:shadow-none lg:flex ${
          preview ? 'hidden lg:flex' : 'flex'
        }`}
        onDragOver={(e) => {
          // Files from outside the browser; a node dragged within the app is
          // a move and is handled by the rows themselves.
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
          {checked.size > 0 ? (
            <>
              <Tooltip label={t('bulk.clear')}>
                <button
                  type="button"
                  aria-label={t('bulk.clear')}
                  onClick={clearChecked}
                  className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <Icon name="close" size={15} />
                </button>
              </Tooltip>
              <span className="text-[13px] font-medium whitespace-nowrap">
                {checked.size} {t('bulk.selected')}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDialog({ kind: 'move' })}
                  className={secondaryButtonClass}
                >
                  {t('files.move')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={removeChecked}
                  className={secondaryButtonClass}
                >
                  {t('files.delete')}
                </button>
              </div>
            </>
          ) : (
            <>
              <Breadcrumb
                trail={trail}
                onDropNodes={(parentId) => void move(draggingRef.current, parentId)}
                dragging={draggingRef}
              />
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={selecting}
                  onClick={() => setSelecting((on) => !on)}
                  className={`${secondaryButtonClass} ${selecting ? 'bg-surface-2 text-ink' : ''}`}
                >
                  {t('files.select')}
                </button>
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
            </>
          )}
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
                  checked={checked.has(node.id)}
                  selecting={selecting || checked.size > 0}
                  previewed={preview?.id === node.id}
                  isDropTarget={dropTarget === node.id}
                  busy={busy}
                  onToggle={(extend) => toggle(node.id, extend)}
                  onOpen={() => {
                    if (node.nodeType === 'directory')
                      void navigate({ to: '/files/$folderId', params: { folderId: node.id } })
                    else setPreview(node)
                  }}
                  onRename={() => setDialog({ kind: 'rename', node })}
                  onDelete={() => removeOne(node)}
                  onDragStart={(e) => {
                    const ids = dragPayload(node)
                    draggingRef.current = ids
                    setFileNodeDrag(
                      e,
                      ids,
                      ids.length > 1 ? `${ids.length} ${t('bulk.selected')}` : node.name,
                    )
                  }}
                  onDragEnd={() => {
                    draggingRef.current = []
                    setDropTarget(null)
                    clearDragState()
                  }}
                  onDragOverFolder={(e) => {
                    if (dragKind(e) !== 'filenode' || !folderTakesDrop(node.id)) return
                    e.preventDefault()
                    setDropTarget(node.id)
                  }}
                  onDragLeaveFolder={() => setDropTarget((at) => (at === node.id ? null : at))}
                  onDropOnFolder={(e) => {
                    if (dragKind(e) !== 'filenode' || !folderTakesDrop(node.id)) return
                    e.preventDefault()
                    // Read before anything clears the module state the touch
                    // fallback keeps the payload in.
                    const ids = readFileNodeDrag(e) ?? draggingRef.current
                    void move(ids, node.id)
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      {preview && (
        <aside className="panel flex h-full w-full shrink-0 overflow-hidden max-sm:rounded-none max-sm:shadow-none lg:w-96">
          <FilePreview
            key={preview.id}
            accountId={accountId}
            node={previewLive ?? preview}
            onClose={() => setPreview(null)}
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
      {dialog?.kind === 'move' && (
        <MoveDialog
          targets={moveTargets(allNodes ?? [], [...checked], folderId)}
          atTopLevel={folderId === null}
          onClose={() => setDialog(null)}
          onPick={(parentId) => {
            setDialog(null)
            void move([...checked], parentId)
          }}
        />
      )}
    </div>
  )
}

function MoveDialog({
  targets,
  atTopLevel,
  onPick,
  onClose,
}: {
  targets: FileNode[]
  atTopLevel: boolean
  onPick: (parentId: string | null) => void
  onClose: () => void
}) {
  // Moving to the top level is only an option when it is not where they are.
  const options: Array<{ id: string | null; name: string }> = [
    ...(atTopLevel ? [] : [{ id: null, name: t('files.move.top') }]),
    ...targets.map((n) => ({ id: n.id as string | null, name: n.name })),
  ]
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal
        aria-label={t('files.move')}
        className={`animate-rise flex max-h-[70vh] w-full max-w-xs flex-col p-5 ${overlayPanelClass}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold">{t('files.move')}</h2>
        {options.length === 0 ? (
          <p className="text-xs text-ink-subtle">{t('files.move.nowhere')}</p>
        ) : (
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {options.map((o) => (
              <li key={o.id ?? 'top'}>
                <button
                  type="button"
                  onClick={() => onPick(o.id)}
                  className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-left text-sm transition-colors hover:bg-surface-2"
                >
                  <Icon name="folder" size={15} className="shrink-0 text-accent" />
                  <span className="truncate">{o.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Breadcrumb({
  trail,
  onDropNodes,
  dragging,
}: {
  trail: FileNode[] | undefined
  onDropNodes: (parentId: string | null) => void
  dragging: { current: string[] }
}) {
  const [over, setOver] = useState<string | null>(null)
  /*
   * The trail doubles as a drop target so a node can be moved *up* the tree,
   * which the listing alone cannot offer: a folder that is not a child of the
   * one being viewed has no row to aim at. Each crumb is always there rather
   * than appearing mid-drag — a target that shows up under way is hard to hit
   * and impossible to hand a drag to in a test.
   */
  const crumbProps = (id: string | null, key: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (dragKind(e) !== 'filenode' || dragging.current.includes(id ?? '')) return
      e.preventDefault()
      setOver(key)
    },
    onDragLeave: () => setOver((at) => (at === key ? null : at)),
    onDrop: (e: React.DragEvent) => {
      if (dragKind(e) !== 'filenode') return
      e.preventDefault()
      setOver(null)
      onDropNodes(id)
    },
    'data-over': over === key || undefined,
  })

  return (
    <nav className="flex min-w-0 items-center gap-1 text-sm">
      <Link
        to="/files"
        {...crumbProps(null, 'root')}
        className="shrink-0 rounded-control px-1.5 py-1 font-medium text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink data-over:bg-accent-wash data-over:text-ink"
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
              {...crumbProps(node.id, node.id)}
              className="truncate rounded-control px-1.5 py-1 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink data-over:bg-accent-wash data-over:text-ink"
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
  checked,
  selecting,
  previewed,
  isDropTarget,
  busy,
  onToggle,
  onOpen,
  onRename,
  onDelete,
  onDragStart,
  onDragEnd,
  onDragOverFolder,
  onDragLeaveFolder,
  onDropOnFolder,
}: {
  node: FileNode
  checked: boolean
  selecting: boolean
  previewed: boolean
  isDropTarget: boolean
  busy: boolean
  onToggle: (extend: boolean) => void
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  onDragOverFolder: (e: React.DragEvent) => void
  onDragLeaveFolder: () => void
  onDropOnFolder: (e: React.DragEvent) => void
}) {
  const isDir = node.nodeType === 'directory'
  /*
   * A draggable element swallows clicks on the controls inside it: pressing
   * the checkbox and moving a pixel starts a drag instead, which is why
   * ticking a row was all but impossible with a mouse. Dragging is therefore
   * switched off while the pointer is over a control, and the row is dragged
   * by its name instead.
   */
  const [dragOff, setDragOff] = useState(false)
  return (
    <li
      draggable={!dragOff}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={suppressContextMenu}
      {...(isDir
        ? {
            onDragOver: onDragOverFolder,
            onDragLeave: onDragLeaveFolder,
            onDrop: onDropOnFolder,
          }
        : {})}
      data-checked={checked || undefined}
      data-selected={previewed || undefined}
      data-over={isDropTarget || undefined}
      className={`group flex items-center gap-1 rounded-control pr-1 transition-colors hover:bg-surface-2 data-checked:bg-accent-wash data-selected:bg-accent-wash data-over:ring-2 data-over:ring-accent ${draggableTouchClass}`}
    >
      <span
        className="shrink-0 py-2 pl-2"
        onMouseEnter={() => setDragOff(true)}
        onMouseLeave={() => setDragOff(false)}
      >
        {/* The icon doubles as the checkbox, the way the avatar does in the
            mail list — and, as there, it reacts to the pointer being on the
            icon itself rather than anywhere in the row, which otherwise reads
            as the folder icon vanishing as the mouse passes by. Touch has no
            hover at all, so there the checkbox appears only once selecting has
            been turned on. */}
        <span className="relative block h-[17px] w-[17px]">
          <Icon
            name={isDir ? 'folder' : 'file'}
            size={17}
            className={`${checked ? 'invisible' : ''} ${isDir ? 'text-accent' : 'text-ink-subtle'}`}
          />
          <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={`${t('files.select')} ${node.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(e.shiftKey)
            }}
            className={`absolute inset-0 flex items-center justify-center rounded-[4px] transition-opacity ${
              checked
                ? 'bg-accent text-accent-ink'
                : `bg-surface-2 text-ink-muted ring-1 ring-line ring-inset ${
                    selecting ? 'opacity-100' : 'opacity-0 hover:opacity-100'
                  }`
            }`}
          >
            <Icon name="check" size={13} />
          </button>
        </span>
      </span>
      <button
        type="button"
        // Labelled by the name alone: the visible text also carries the size
        // or "Folder", and the row's other two buttons carry the name too, so
        // without this there is no way to address just this row.
        aria-label={node.name}
        // While selecting, the whole row is a target for the selection rather
        // than a way into the folder — otherwise ticking things on a phone
        // means hitting a 17px box.
        onClick={(e) => (selecting ? onToggle(e.shiftKey) : onOpen())}
        className="flex min-w-0 flex-1 items-center py-2 pl-2 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{node.name}</span>
          <span className="block truncate text-xs text-ink-subtle">
            {isDir ? t('files.folder') : formatBytes(node.size ?? 0)}
          </span>
        </span>
      </button>
      {/* Kept mounted rather than conditionally rendered: a row whose buttons
          appear on hover would change height as the pointer crosses it. */}
      <span
        onMouseEnter={() => setDragOff(true)}
        onMouseLeave={() => setDragOff(false)}
        className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-lg:opacity-100"
      >
        <Tooltip label={t('files.rename')}>
          <button
            type="button"
            aria-label={`${t('files.rename')} ${node.name}`}
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
            aria-label={`${t('files.delete')} ${node.name}`}
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
