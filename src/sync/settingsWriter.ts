/*
 * Putting settings on the server: the half of settings sync that talks to
 * it. Mirrors noteWriter.ts's shape — kept out of outbox.ts for the same
 * reason (the longest single action there is) and out of services/settings.ts
 * because that half must never touch the network.
 */

import type { FilesProvider, SetFailure } from '../providers/types'
import { collectLocalSettings, type SyncedField } from '../services/settings'
import { findOrCreateFolder } from './noteWriter'

/** Mel's own internal files, kept apart from user content (`Notes/`) and
 *  hidden from the Files browser by dotfile convention — see tree.ts. */
export const MEL_FOLDER = '.mel'
export const SETTINGS_FILE = 'settings.json'
const SETTINGS_TYPE = 'application/json'

function fail(failure: SetFailure): Error {
  return Object.assign(new Error(failure.description ?? failure.type), {
    permanent: failure.permanent,
  })
}

/**
 * Parse defensively: the file may have been hand-edited, or written by a
 * future or otherwise incompatible client. Malformed content is treated as
 * empty rather than thrown — the write below then treats every local key as
 * new, and the file self-heals on this push.
 */
function tryParse(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Write `.mel/settings.json`, merged onto whatever is already there.
 *
 * Read-merge-write, not a blind overwrite, in two senses stacked on top of
 * each other:
 *
 * - Any top-level key this build does not recognise (an older or newer mel
 *   version's own field) passes through untouched — the same "unknown keys
 *   kept and written back" rule the note front matter already follows, so
 *   schema evolution never loses data in either direction.
 * - Of the keys this build *does* recognise, only the ones named in
 *   `fields` are overwritten. Everything else known survives from the
 *   server exactly as it was — including a field a different device
 *   changed after this one last synced, which this device's own local copy
 *   would otherwise be stale for. This is what makes two devices changing
 *   different settings concurrently converge correctly instead of the
 *   second push silently discarding the first's unrelated change.
 *
 * No marker is written here for "this is now applied" — that bookkeeping
 * lives entirely in `sync/settings.ts`'s `reconcileSettings`, compared
 * against the local file-tree mirror rather than anything this write could
 * hand back. Neither `createFile` nor `writeFileContent` return the node's
 * `modified` (see `docs/notes/filenode.md`), and stamping a marker from the
 * client's own clock would risk a clock-skewed device shadowing a genuine
 * later change from another one. `flush()` already resyncs the account
 * after every outbox action, which is what brings the true server
 * `modified` into `db.files` for the next `reconcileSettings` to compare —
 * exactly the mechanism Notes' own read model already relies on.
 */
export async function saveSettingsFile(
  accountId: string,
  files: FilesProvider,
  fields: SyncedField[],
): Promise<void> {
  const rootId = await findOrCreateFolder(files, null, MEL_FOLDER)
  const children = await files.listChildren(rootId)
  const existing = children.find((c) => c.nodeType === 'file' && c.name === SETTINGS_FILE)

  const current = existing ? await files.readFile(existing) : null
  const onServer = current ? tryParse(await current.text()) : {}
  const local = collectLocalSettings(accountId)
  const merged: Record<string, unknown> = { ...onServer, version: 1 }
  for (const field of fields) merged[field] = local[field]
  const text = new Blob([JSON.stringify(merged)], { type: SETTINGS_TYPE })

  if (existing) {
    const failure = await files.writeFileContent(existing.id, text, SETTINGS_TYPE)
    if (failure) throw fail(failure)
  } else {
    const created = await files.createFile({
      name: SETTINGS_FILE,
      parentId: rootId,
      data: text,
      type: SETTINGS_TYPE,
    })
    if (created.failure) throw fail(created.failure)
  }
}
