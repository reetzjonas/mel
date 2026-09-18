/*
 * Keeping settings in step with `.mel/settings.json` — the read half of
 * settings sync (issue #20). Mirrors sync/notes.ts's reconcile shape.
 */

import type { FileNode } from '../domain/file'
import type { FilesProvider } from '../providers/types'
import {
  ALL_SYNCED_FIELDS,
  applySettingsSilently,
  enqueueSettingsSave,
  pendingSyncFields,
} from '../services/settings'
import { getState, putState } from './engine'
import { fileTree } from './notes'
import { MEL_FOLDER, SETTINGS_FILE } from './settingsWriter'

/** What `reconcileSettings`'s applied marker is filed under in `db.syncState`. */
const COLLECTION = 'Settings'

function melRoot(nodes: FileNode[]): FileNode | undefined {
  return nodes.find(
    (n) => n.parentId === null && n.nodeType === 'directory' && n.name === MEL_FOLDER,
  )
}

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
 * Bring local settings up to date with `.mel/settings.json`, or push the
 * local ones up if the file does not exist yet.
 *
 * Called after the file tree has synced (`syncFiles`), exactly where
 * `reconcileNotes` is — on its own this would work from a stale tree and
 * miss the very file that just changed, including one this same device
 * wrote a moment ago (see settingsWriter.ts).
 */
export async function reconcileSettings(accountId: string, files: FilesProvider): Promise<void> {
  const nodes = await fileTree(accountId)
  const root = melRoot(nodes)
  const settingsFile = root
    ? nodes.find((n) => n.parentId === root.id && n.nodeType === 'file' && n.name === SETTINGS_FILE)
    : undefined

  if (!settingsFile) {
    // Nothing on the server yet — this is the bootstrap: push everything
    // known, since there is nothing there for a scoped push to preserve. No
    // capability check needed (unlike `scheduleSettingsSync`): being handed
    // a `FilesProvider` at all already means the account has one.
    await enqueueSettingsSave(accountId, ALL_SYNCED_FIELDS)
    return
  }

  const applied = await getState(accountId, COLLECTION)
  // Lexicographic comparison is correct for ISO 8601 UTC timestamps at the
  // same precision, which is what FileNode's `modified` always is.
  if (applied !== undefined && settingsFile.modified <= applied) return

  const blob = await files.readFile(settingsFile)
  // Not readable right now (offline mid-sync, a server hiccup) — not a
  // reason to touch the marker; the next sync tries again against the same
  // unapplied file rather than silently accepting a state that was never
  // actually read.
  if (!blob) return

  const parsed = tryParse(await blob.text())
  /*
   * A field this device is about to push (or is pushing right now) carries
   * this device's own latest edit — the queued action reads it fresh only
   * when it actually runs, so applying an older value pulled in the
   * meantime would silently clobber that edit before it ever reaches the
   * server. See pendingSyncFields' comment.
   */
  for (const field of await pendingSyncFields(accountId)) delete parsed[field]
  applySettingsSilently(accountId, parsed)
  await putState(accountId, COLLECTION, settingsFile.modified)
}
