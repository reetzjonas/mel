import { useEffect, useState } from 'react'
import type { FilterRule, SieveScript } from '../../domain/sieve'
import { t } from '../../lib/i18n'
import {
  emptyRule,
  mailboxPaths,
  ruleForSender,
  rulesFromScript,
  stripRuleMarker,
  toSieveScript,
  unfinishedRules,
} from '../../lib/sieveScript'
import { useUi } from '../../app/store'
import { useMailboxes } from '../mail/hooks'
import { RuleWizard } from './RuleWizard'
import {
  checkScript,
  deleteScript,
  listScripts,
  readScript,
  saveScript,
  setActiveScript,
  type SieveOutcome,
} from '../../services/sieve'
import { Icon } from '../../ui/Icon'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../ui/styles'

/**
 * What is being edited: the guided form, or the script itself.
 *
 * Which one you get is not a preference but a fact about the script. The form
 * can only show back what the form wrote — see lib/sieveScript.ts — so a
 * hand-written script is offered as text and says why.
 */
type Draft =
  /** Absent `id` for a script that does not exist yet. */
  | { mode: 'rules'; id?: string; name: string; rules: FilterRule[] }
  | { mode: 'text'; id?: string; name: string; content: string; handWritten: boolean }

function scriptOf(draft: Draft): string {
  return draft.mode === 'rules' ? toSieveScript(draft.rules) : stripRuleMarker(draft.content)
}

type Note = { kind: 'error' | 'ok'; text: string } | null

export function SieveSetting({ accountId }: { accountId: string }) {
  const [scripts, setScripts] = useState<SieveScript[] | null>(null)
  /*
   * Seeded from the reading pane, if that is how we got here. Read as the
   * initial state rather than set from an effect: the dialog mounts fresh each
   * time it opens, so this is the first render's own input, and an effect
   * would spend a render showing an empty form first.
   */
  const seed = useUi.getState().filterSeed
  const [draft, setDraft] = useState<Draft | null>(
    seed ? { mode: 'rules', name: seed.from, rules: [ruleForSender(seed.from)] } : null,
  )
  const [note, setNote] = useState<Note>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<SieveScript | null>(null)
  const mailboxes = useMailboxes(accountId)
  const setFilterSeed = useUi((s) => s.setFilterSeed)
  const folders = mailboxPaths(mailboxes ?? [])

  const refresh = async () => setScripts(await listScripts(accountId))

  useEffect(() => {
    void listScripts(accountId).then(setScripts)
  }, [accountId])

  // Cleared once taken, so reopening settings later does not start the same
  // draft again over whatever is on screen by then.
  useEffect(() => {
    setFilterSeed(null)
  }, [setFilterSeed])

  const report = (r: SieveOutcome) => {
    setNote(
      r.ok
        ? null
        : {
            kind: 'error',
            // "Switch it off first" is something to act on; the server's own
            // sentence only explains why it refused.
            text: r.blocker === 'active' ? t('sieve.delete.active') : (r.message ?? ''),
          },
    )
    return r.ok
  }

  const run = async (op: () => Promise<SieveOutcome>) => {
    setBusy(true)
    try {
      const ok = report(await op())
      await refresh()
      return ok
    } finally {
      setBusy(false)
    }
  }

  const edit = async (script: SieveScript) => {
    setNote(null)
    setBusy(true)
    try {
      const content = await readScript(accountId, script)
      const rules = rulesFromScript(content)
      setDraft(
        rules
          ? { mode: 'rules', id: script.id, name: script.name, rules }
          : { mode: 'text', id: script.id, name: script.name, content, handWritten: true },
      )
    } finally {
      setBusy(false)
    }
  }

  const save = async (activate: boolean) => {
    if (!draft) return
    if (!draft.name.trim()) return setNote({ kind: 'error', text: t('sieve.nameRequired') })
    // A rule whose folder was never chosen generates nothing at all, so saving
    // it would report success for a rule that quietly does not exist.
    if (draft.mode === 'rules' && unfinishedRules(draft.rules).length)
      return setNote({ kind: 'error', text: t('rule.needsFolder') })
    const ok = await run(() =>
      saveScript(accountId, {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        content: scriptOf(draft),
        activate,
      }),
    )
    if (ok) setDraft(null)
  }

  const check = async () => {
    if (!draft) return
    setBusy(true)
    try {
      const error = await checkScript(accountId, scriptOf(draft))
      setNote(error ? { kind: 'error', text: error } : { kind: 'ok', text: t('sieve.valid') })
    } finally {
      setBusy(false)
    }
  }

  const remove = (script: SieveScript) => {
    setDeleting(script)
  }

  if (scripts === null) return <p className="text-sm text-ink-muted">{t('sieve.loading')}</p>

  return (
    <>
      <div className="space-y-3">
        <p className="text-sm text-ink-muted">{t('sieve.hint')}</p>

        {note && (
          <p
            role="status"
            className={`rounded-control px-3 py-2 text-xs ${
              note.kind === 'error' ? 'bg-danger/10 text-danger' : 'bg-accent-wash text-ink'
            }`}
          >
            {note.text}
          </p>
        )}

        {draft ? (
          <div className="space-y-2">
            <input
              className={inputClass}
              aria-label={t('sieve.name')}
              placeholder={t('sieve.name')}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            {draft.mode === 'rules' ? (
              <RuleWizard
                rules={draft.rules}
                folders={folders}
                onChange={(rules) => setDraft({ ...draft, rules })}
              />
            ) : (
              <>
                <p className="text-xs text-ink-subtle">
                  {draft.handWritten ? t('rule.handWritten') : t('rule.textWarning')}
                </p>
                <textarea
                  className={`${inputClass} min-h-48 font-mono text-xs`}
                  aria-label={t('sieve.script')}
                  spellCheck={false}
                  value={draft.content}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                />
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                className={primaryButtonClass}
                onClick={() => void save(true)}
              >
                {t('sieve.saveActive')}
              </button>
              <button
                type="button"
                disabled={busy}
                className={secondaryButtonClass}
                onClick={() => void save(false)}
              >
                {t('sieve.save')}
              </button>
              <button
                type="button"
                disabled={busy}
                className={secondaryButtonClass}
                onClick={() => void check()}
              >
                {t('sieve.check')}
              </button>
              {draft.mode === 'rules' && (
                /*
                 * One way only. Going back would mean reading the rules off the
                 * marker line, which no longer describes a body edited by hand —
                 * so the form would show one thing, saving would write another,
                 * and the text edits would be gone without a word.
                 */
                <button
                  type="button"
                  className={secondaryButtonClass}
                  onClick={() =>
                    setDraft({
                      mode: 'text',
                      ...(draft.id ? { id: draft.id } : {}),
                      name: draft.name,
                      content: toSieveScript(draft.rules),
                      handWritten: false,
                    })
                  }
                >
                  {t('rule.asText')}
                </button>
              )}
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => {
                  setDraft(null)
                  setNote(null)
                }}
              >
                {t('sieve.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <>
            {scripts.length === 0 ? (
              <p className="text-sm text-ink-muted">{t('sieve.none')}</p>
            ) : (
              <ul className="space-y-1">
                {scripts.map((script) => (
                  <li
                    key={script.id}
                    className="flex items-center gap-2 rounded-control bg-surface-2 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{script.name}</span>
                    {script.isActive && (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold tracking-wide text-accent-ink uppercase">
                        <Icon name="check" size={11} />
                        {t('sieve.active')}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      className="shrink-0 text-xs text-accent hover:underline"
                      onClick={() =>
                        void run(() =>
                          setActiveScript(accountId, script.isActive ? null : script.id),
                        )
                      }
                    >
                      {script.isActive ? t('sieve.deactivate') : t('sieve.activate')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="shrink-0 text-xs text-ink-muted hover:text-ink hover:underline"
                      onClick={() => void edit(script)}
                    >
                      {t('sieve.edit')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="shrink-0 text-xs text-ink-muted hover:text-danger hover:underline"
                      onClick={() => remove(script)}
                    >
                      {t('sieve.delete')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                setNote(null)
                setDraft({ mode: 'rules', name: '', rules: [emptyRule()] })
              }}
            >
              {t('sieve.new')}
            </button>
          </>
        )}
      </div>
      {deleting && (
        <ConfirmDialog
          title={t('sieve.delete')}
          message={t('sieve.delete.confirm')}
          cancelLabel={t('sieve.cancel')}
          confirmLabel={t('sieve.delete')}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            void run(() => deleteScript(accountId, deleting.id))
            setDeleting(null)
          }}
        />
      )}
    </>
  )
}
