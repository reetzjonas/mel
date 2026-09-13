import { useEffect, useState } from 'react'
import type { SieveScript } from '../../domain/sieve'
import { t } from '../../lib/i18n'
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
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../ui/styles'

interface Draft {
  /** Absent for a script that does not exist yet. */
  id?: string
  name: string
  content: string
}

type Note = { kind: 'error' | 'ok'; text: string } | null

export function SieveSetting({ accountId }: { accountId: string }) {
  const [scripts, setScripts] = useState<SieveScript[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [note, setNote] = useState<Note>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => setScripts(await listScripts(accountId))

  useEffect(() => {
    void listScripts(accountId).then(setScripts)
  }, [accountId])

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
      setDraft({ id: script.id, name: script.name, content: await readScript(accountId, script) })
    } finally {
      setBusy(false)
    }
  }

  const save = async (activate: boolean) => {
    if (!draft) return
    if (!draft.name.trim()) return setNote({ kind: 'error', text: t('sieve.nameRequired') })
    const ok = await run(() =>
      saveScript(accountId, {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        content: draft.content,
        activate,
      }),
    )
    if (ok) setDraft(null)
  }

  const check = async () => {
    if (!draft) return
    setBusy(true)
    try {
      const error = await checkScript(accountId, draft.content)
      setNote(error ? { kind: 'error', text: error } : { kind: 'ok', text: t('sieve.valid') })
    } finally {
      setBusy(false)
    }
  }

  const remove = (script: SieveScript) => {
    if (!window.confirm(t('sieve.delete.confirm'))) return
    void run(() => deleteScript(accountId, script.id))
  }

  if (scripts === null) return <p className="text-sm text-ink-muted">{t('sieve.loading')}</p>

  return (
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
          <textarea
            className={`${inputClass} min-h-48 font-mono text-xs`}
            aria-label={t('sieve.script')}
            spellCheck={false}
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          />
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
                      void run(() => setActiveScript(accountId, script.isActive ? null : script.id))
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
              setDraft({ name: '', content: '' })
            }}
          >
            {t('sieve.new')}
          </button>
        </>
      )}
    </div>
  )
}
