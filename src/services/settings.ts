/*
 * Mirroring the device-local settings to `.mel/settings.json` (JMAP
 * FileNode), for an account that offers file storage — issue #20.
 *
 * Every setting here already has its own getter/setter, used exactly as
 * before by whatever changed it. This module only aggregates them for a
 * push (`collectLocalSettings`), applies a pulled value back into each one
 * (`applySettingsSilently`, called only by `sync/settings.ts`'s reconcile —
 * never by anything a person clicked), and triggers a push
 * (`scheduleSettingsSync`, called explicitly from the UI control that just
 * changed something).
 *
 * `applySettingsSilently` deliberately does not call the same setter a user
 * edit would: `setThemeTuning` and `useUi().setConversationView` never push
 * on their own (the push happens at the UI call site instead), so calling
 * them here is safe and needs no separate "silent" variant. Theme
 * preference and language are the two that do need one — see
 * `applyThemePreferenceSilently` (no module-level store exists for theme
 * preference to update in place) and the language handling below (a remote
 * language change cannot apply in place at all; see the comment there).
 */

import { applyThemePreferenceSilently, STORAGE_KEY as THEME_KEY } from '../app/theme'
import { setThemeTuning, themeTuning, type ThemeTuning } from '../app/themeTuning'
import { useUi } from '../app/store'
import { conversationView } from '../lib/conversationView'
import { applyHiddenCalendarsSilently, readHiddenCalendars } from '../lib/hiddenCalendars'
import { t } from '../lib/i18n'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { enqueue, type OutboxAction } from '../sync/outbox'

const LANG_KEY = 'mel:lang'

export interface SyncedSettings {
  version: 1
  theme?: 'light' | 'dark' | 'system'
  themeTuning?: ThemeTuning | null
  lang?: 'system' | 'en' | 'de'
  conversationView?: boolean
  hiddenCalendars?: string[]
}

export type SyncedField = Exclude<keyof SyncedSettings, 'version'>

/** Every field this build can push — what the bootstrap write uses. */
export const ALL_SYNCED_FIELDS: SyncedField[] = [
  'theme',
  'themeTuning',
  'lang',
  'conversationView',
  'hiddenCalendars',
]

/** Everything this build knows how to sync, read fresh from local storage. */
export function collectLocalSettings(accountId: string): SyncedSettings {
  const storedTheme = localStorage.getItem(THEME_KEY)
  const storedLang = localStorage.getItem(LANG_KEY)
  return {
    version: 1,
    theme: storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'system',
    themeTuning: themeTuning(),
    lang: storedLang === 'en' || storedLang === 'de' ? storedLang : 'system',
    conversationView: conversationView(),
    hiddenCalendars: readHiddenCalendars(accountId),
  }
}

function isThemeTuning(v: unknown): v is ThemeTuning {
  if (!v || typeof v !== 'object') return false
  const tuning = v as Partial<ThemeTuning>
  return [tuning.accentHue, tuning.accentChroma, tuning.surfaceHue, tuning.surfaceTint].every(
    (n) => typeof n === 'number' && Number.isFinite(n),
  )
}

/**
 * A remote language change cannot apply in place — there is no listener
 * anywhere in `lib/i18n.ts`, only a `location.reload()` the language
 * `<select>` itself triggers. Reloading automatically from a background
 * sync would drop whatever the person is in the middle of (there is no
 * draft-loss guard anywhere in mel today), so this writes storage for the
 * *next* reload and offers one rather than forcing it.
 */
function applyLanguageSilently(lang: 'system' | 'en' | 'de'): void {
  const current = localStorage.getItem(LANG_KEY) ?? 'system'
  if (current === lang) return
  if (lang === 'system') localStorage.removeItem(LANG_KEY)
  else localStorage.setItem(LANG_KEY, lang)
  useUi.getState().showSnackbar({
    message: t('settings.sync.languageChanged'),
    actionLabel: t('app.reload'),
    action: () => location.reload(),
  })
}

/**
 * Apply a settings blob pulled from the server. Each field is applied only
 * if it both exists and passes a shape check — the file may have been
 * hand-edited, or written by a future/incompatible client — and a field
 * this build does not recognise at all is simply never read here (it still
 * round-trips: see `sync/settingsWriter.ts`'s read-merge-write).
 */
export function applySettingsSilently(accountId: string, parsed: Record<string, unknown>): void {
  if (parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system') {
    applyThemePreferenceSilently(parsed.theme)
  }
  if (parsed.themeTuning === null || isThemeTuning(parsed.themeTuning)) {
    setThemeTuning((parsed.themeTuning as ThemeTuning | null) ?? null)
  }
  if (typeof parsed.conversationView === 'boolean') {
    // The store's own action, not the bare module setter: it also updates
    // the zustand mirror an already-mounted mail list reads, which a direct
    // `lib/conversationView.ts` write would leave stale until a remount.
    useUi.getState().setConversationView(parsed.conversationView)
  }
  if (
    Array.isArray(parsed.hiddenCalendars) &&
    parsed.hiddenCalendars.every((v) => typeof v === 'string')
  ) {
    applyHiddenCalendarsSilently(accountId, parsed.hiddenCalendars as string[])
  }
  if (parsed.lang === 'system' || parsed.lang === 'en' || parsed.lang === 'de') {
    applyLanguageSilently(parsed.lang)
  }
}

/** Whether this account is known to offer file storage — false if unknown or locked. */
async function hasFilesCapability(accountId: string): Promise<boolean> {
  try {
    const row = await db.accounts.get(accountId)
    if (!row) return false
    return openEnvelope(row.payload).account.capabilities.files
  } catch {
    // A sealed (locked) account, or a row this build cannot read — treated
    // as "cannot tell", not as "yes, push".
    return false
  }
}

/**
 * How long a push waits before it actually runs.
 *
 * This delay exists because `outbox.ts`'s `flush()` runs a **full** account
 * resync after every successful action, settings included — and a push
 * triggered from an inline control (the calendar sidebar's visibility
 * checkbox, not a modal) landed that resync in the middle of whatever the
 * person did next, re-rendering event rows out from under a click a moment
 * later. Reproduced and bisected against `e2e/calendar.spec.ts`'s day-view
 * test, which failed 3/3 with the push firing immediately and passed once
 * delayed. The Settings dialog's own controls pay the same delay for
 * simplicity, though nothing behind a modal is at risk of this. See
 * `docs/notes/settings-sync.md`.
 */
const PUSH_DELAY_MS = 3_000

/**
 * A pending, not-yet-due `settings.save` for this account, if one exists.
 */
async function pendingSave(
  accountId: string,
): Promise<{ seq: number; fields: SyncedField[] } | null> {
  const rows = await db.outbox.where('accountId').equals(accountId).toArray()
  const row = rows.find((r) => r.kind === 'settings.save' && r.status === 'pending')
  if (!row) return null
  const action = openEnvelope(row.payload) as OutboxAction
  return action.kind === 'settings.save' ? { seq: row.seq!, fields: action.fields } : null
}

/**
 * Fields this device is about to push, or is pushing right now.
 *
 * `sync/settings.ts`'s `reconcileSettings` uses this to skip re-applying a
 * pulled value for any of these fields: `collectLocalSettings` reads the
 * *current* value only when the queued action actually executes, so
 * whatever is in flight already carries this device's own latest edit —
 * applying a value read from the server in the meantime would silently
 * overwrite that edit with what it looked like before this device changed
 * it, and the edit would never reach the server at all. Found by tracing a
 * reload in `e2e/theme-editor.spec.ts` that produced a different symptom on
 * every run: a slow initial reconcile, still in flight after login,
 * resolving *after* a slider change and clobbering it before the change's
 * own debounced push ever fired.
 *
 * `'inflight'` rows count too, not just `'pending'` ones — a push already
 * under way is still this device's authoritative intent for that field
 * until it either lands or is retried.
 */
export async function pendingSyncFields(accountId: string): Promise<SyncedField[]> {
  const rows = await db.outbox.where('accountId').equals(accountId).toArray()
  const fields = new Set<SyncedField>()
  for (const row of rows) {
    if (row.kind !== 'settings.save' || row.status === 'failed') continue
    const action = openEnvelope(row.payload) as OutboxAction
    if (action.kind === 'settings.save') for (const f of action.fields) fields.add(f)
  }
  return [...fields]
}

/**
 * Queue a push of the given fields, no capability check — for
 * `sync/settings.ts`'s bootstrap path, which only ever runs once
 * `conn.files` is already known to exist (that is what it is reconciling),
 * so re-checking the persisted capability flag here would risk a false
 * no-op in the first moments after an account is added, before that flag
 * has been written back to `db.accounts`.
 *
 * A field is **merged into an already-pending push** rather than skipped
 * outright: two different settings changing within the delay window used
 * to mean the second one was silently dropped (a pending-action check with
 * no memory of which field it actually carried) — now both survive in one
 * write. This also keeps a push scoped to only the fields that actually
 * changed on *this* device, rather than resending every known field every
 * time: two devices changing different settings, even mid-flight against
 * each other, both keep their own change — the read-merge-write in
 * `settingsWriter.ts` only overwrites a field this push explicitly names,
 * everything else on the server (including a field the *other* device just
 * changed) passes through untouched.
 */
export async function enqueueSettingsSave(accountId: string, fields: SyncedField[]): Promise<void> {
  const pending = await pendingSave(accountId)
  if (pending) {
    const union = [...new Set([...pending.fields, ...fields])]
    await db.outbox.update(pending.seq, {
      payload: sealPlain({ kind: 'settings.save', fields: union }),
    })
    return
  }
  await enqueue(accountId, { kind: 'settings.save', fields }, { delayMs: PUSH_DELAY_MS })
}

/**
 * Queue a push of the given fields, called from wherever a synced setting
 * was just changed by hand.
 *
 * No `files` capability is the local-only fallback the issue asks for: this
 * is skipped entirely, so nothing about it costs a network call on a server
 * that cannot store the file.
 */
export async function scheduleSettingsSync(
  accountId: string,
  fields: SyncedField[],
): Promise<void> {
  if (!(await hasFilesCapability(accountId))) return
  await enqueueSettingsSave(accountId, fields)
}
