import { useRef, useState } from 'react'

/**
 * What a row contributes to selection math.
 *
 * `key` anchors shift-click range-select and must be unique per row. `ids`
 * is what toggling the row actually adds to or removes from the selection —
 * more than one when a row stands for something wider than itself, the way
 * a folded mail conversation's row toggles every message in it at once.
 * Files, Contacts and Notes rows have exactly one id each; Mail's don't.
 */
export interface SelectableRow {
  key: string
  ids: string[]
}

export interface Selection {
  selected: Set<string>
  /** Whether checkboxes are pinned visible — the touch entry point, since
   *  touch has no hover to reveal them the way a desktop pointer does. */
  selecting: boolean
  setSelecting: (on: boolean) => void
  isSelected: (id: string) => boolean
  /** Tick one row, or with shift the whole run since the last row ticked. */
  toggle: (key: string, extend: boolean) => void
  /** Replace the selection outright — "select everything", "select all". */
  setSelected: (ids: string[]) => void
  clear: () => void
}

/**
 * Multi-select with shift-click range-select over a list.
 *
 * Generalized from `ThreadList.pickRow` and `FileBrowser.toggle`, which
 * independently built the same shape: an anchor ref recording the last row
 * ticked on its own, and a `Set<string>` of what's ticked. A range only ever
 * adds — clicking shift over rows that cross an already-ticked one must not
 * untick it, since that would undo a deliberate earlier choice the range
 * happened to sweep past.
 */
export function useSelection(rows: SelectableRow[]): Selection {
  const [selected, setSelectedState] = useState<Set<string>>(new Set())
  const [selecting, setSelecting] = useState(false)
  const anchor = useRef<string | null>(null)

  const toggle = (key: string, extend: boolean) => {
    const to = rows.findIndex((r) => r.key === key)
    const from = rows.findIndex((r) => r.key === anchor.current)
    if (extend && from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from]
      setSelectedState(
        (prev) => new Set([...prev, ...rows.slice(lo, hi + 1).flatMap((r) => r.ids)]),
      )
      return
    }
    anchor.current = key
    const row = rows.find((r) => r.key === key)
    if (!row) return
    setSelectedState((prev) => {
      const next = new Set(prev)
      // If every id this row carries is already in, the row reads as
      // "ticked" and the click means take it out — all of it, together.
      const allIn = row.ids.every((id) => next.has(id))
      for (const id of row.ids) {
        if (allIn) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const setSelected = (ids: string[]) => {
    anchor.current = ids.at(-1) ?? null
    setSelectedState(new Set(ids))
  }

  const clear = () => {
    setSelectedState(new Set())
    setSelecting(false)
    anchor.current = null
  }

  return {
    selected,
    selecting,
    setSelecting,
    isSelected: (id) => selected.has(id),
    toggle,
    setSelected,
    clear,
  }
}
