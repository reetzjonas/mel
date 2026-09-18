import { Outlet, createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useMemo, useRef, useState } from 'react'
import { useAccounts } from '../../features/mail/hooks'
import { NoteCard } from '../../features/notes/NoteCard'
import { useNotes } from '../../features/notes/hooks'
import { CapabilityNotice } from '../../features/settings/ServerCapabilities'
import { t } from '../../lib/i18n'
import { PANEL_WIDTH_VAR, usePanelWidth, type PanelLimits } from '../../lib/panelWidths'
import { useSelection } from '../../lib/selection'
import { deleteNote, emptyNote, saveNote } from '../../services/notes'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { ResizeHandle } from '../../ui/ResizeHandle'
import { SearchInput } from '../../ui/SearchInput'
import { SelectionActionButton, SelectionToolbar } from '../../ui/SelectionToolbar'
import { ListSkeleton } from '../../ui/Skeleton'
import { Tooltip } from '../../ui/Tooltip'
import { primaryIconButtonClass, secondaryButtonClass } from '../../ui/styles'

const LIST_LIMITS: PanelLimits = { min: 240, max: 480, initial: 320 }

export const Route = createFileRoute('/notes')({
  component: NotesLayout,
})

/**
 * Notes ride on file storage, so they answer to the same capability the Files
 * tab does: no FileNode, nowhere to keep a note.
 */
function NotesLayout() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const notes = useNotes(account?.id)
  const params = useParams({ strict: false }) as { noteId?: string }
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const listPanel = usePanelWidth('notes-list', LIST_LIMITS)
  const listRef = useRef<HTMLElement | null>(null)

  const filtered = useMemo(() => {
    if (!notes) return undefined
    const needle = filter.trim().toLowerCase()
    return needle ? notes.filter((n) => n.title.toLowerCase().includes(needle)) : notes
  }, [notes, filter])

  const selectionRows = useMemo(
    () => (filtered ?? []).map((n) => ({ key: n.id, ids: [n.id] })),
    [filtered],
  )
  const { selected: checked, selecting, setSelecting, toggle, clear } = useSelection(selectionRows)

  if (accounts === undefined) return null
  if (!account?.capabilities.files) return <CapabilityNotice reason="caps.unsupported.files" />

  const create = async () => {
    const note = await saveNote(account.id, emptyNote())
    await navigate({ to: '/notes/$noteId', params: { noteId: note.id } })
  }

  const setPinned = async (pinned: boolean) => {
    const picked = (notes ?? []).filter((n) => checked.has(n.id))
    clear()
    setBusy(true)
    try {
      await Promise.all(picked.map((n) => saveNote(account.id, { ...n, pinned })))
    } finally {
      setBusy(false)
    }
  }

  const removeChecked = async () => {
    if (!window.confirm(t('notes.delete.selection'))) return
    const picked = (notes ?? []).filter((n) => checked.has(n.id))
    clear()
    setBusy(true)
    try {
      await Promise.all(picked.map((n) => deleteNote(account.id, n)))
      if (params.noteId && picked.some((n) => n.id === params.noteId))
        void navigate({ to: '/notes' })
    } finally {
      setBusy(false)
    }
  }

  const inDetail = Boolean(params.noteId)

  return (
    <div className="flex h-full gap-0 bg-canvas sm:gap-3 sm:p-3">
      <section
        ref={listRef}
        style={{ [PANEL_WIDTH_VAR]: `${listPanel.width}px` } as React.CSSProperties}
        className={`panel flex h-full w-full min-w-0 flex-col overflow-hidden max-sm:rounded-none max-sm:shadow-none lg:flex lg:w-[var(--mel-panel-w)] lg:shrink-0 ${inDetail ? 'hidden lg:flex' : ''}`}
      >
        {checked.size > 0 ? (
          <SelectionToolbar count={checked.size} onClear={clear} busy={busy}>
            <SelectionActionButton
              icon="flag"
              label={t('notes.pin')}
              disabled={busy}
              onClick={() => void setPinned(true)}
            />
            <SelectionActionButton
              icon="flagOff"
              label={t('notes.unpin')}
              disabled={busy}
              onClick={() => void setPinned(false)}
            />
            <SelectionActionButton
              icon="trash"
              label={t('notes.delete')}
              disabled={busy}
              onClick={() => void removeChecked()}
            />
          </SelectionToolbar>
        ) : (
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <SearchInput
              value={filter}
              onChange={setFilter}
              placeholder={t('notes.search')}
              clearLabel={t('search.clear')}
            />
            <button
              type="button"
              aria-pressed={selecting}
              onClick={() => setSelecting(!selecting)}
              className={`${secondaryButtonClass} ${selecting ? 'bg-surface-2 text-ink' : ''}`}
            >
              {t('notes.selectToggle')}
            </button>
            <Tooltip label={t('notes.new')}>
              <button
                type="button"
                aria-label={t('notes.new')}
                onClick={() => void create()}
                className={primaryIconButtonClass}
              >
                <Icon name="compose" size={15} />
              </button>
            </Tooltip>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {filtered === undefined ? (
            <ListSkeleton lines={0} />
          ) : filtered.length === 0 && filter ? (
            <EmptyState icon="search" title={t('notes.noResults')} />
          ) : filtered.length === 0 ? (
            <EmptyState icon="draft" title={t('notes.empty')} hint={t('notes.emptyHint')} />
          ) : (
            filtered.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                selected={note.id === params.noteId}
                checked={checked.has(note.id)}
                selecting={selecting || checked.size > 0}
                onToggle={(extend) => toggle(note.id, extend)}
              />
            ))
          )}
        </div>
      </section>
      <ResizeHandle
        limits={LIST_LIMITS}
        label={t('notes.resizeList')}
        width={listPanel.width}
        targetRef={listRef}
        onCommit={listPanel.commit}
        onReset={listPanel.reset}
      />
      <div className={`h-full min-w-0 flex-1 lg:block ${inDetail ? '' : 'hidden'}`}>
        <div className="panel h-full overflow-hidden max-sm:rounded-none max-sm:shadow-none">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
