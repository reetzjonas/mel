import { useState } from 'react'
import type { AuthMethod } from '../../domain/account'
import { discoveryCandidates, srvCandidates } from '../../providers/jmap/client/session'
import { t } from '../../lib/i18n'
import { addAccount, NoServerFound } from '../../services/accounts'
import { Icon } from '../../ui/Icon'
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../ui/styles'

/**
 * One mask for every server. The email address is enough for the common case:
 * discoveryCandidates() probes the conventional hosts, and only if all of them
 * miss do the wider options (DNS lookup, manual URL) appear — see below.
 */
export function AddAccountForm({ onDone }: { onDone: (accountId: string) => void }) {
  const [email, setEmail] = useState('')
  const [secret, setSecret] = useState('')
  const [method, setMethod] = useState<AuthMethod>('basic')
  const [manualServer, setManualServer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set once the guesses have come up empty; unlocks the fallbacks.
  const [notFound, setNotFound] = useState(false)

  const credentials = () => ({
    method,
    username: method === 'basic' ? email.trim() : undefined,
    secret,
  })

  async function connect(candidates: string[]) {
    setBusy(true)
    setError(null)
    try {
      onDone(await addAccount(candidates, credentials()))
    } catch (err) {
      if (err instanceof NoServerFound) {
        setNotFound(true)
        setError(t('login.noServer'))
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    void connect(
      manualServer.trim() ? [manualServer.trim()] : discoveryCandidates(email),
    )
  }

  /** Opt-in only: this is the one step that tells a third party our domain. */
  async function lookupViaDns() {
    setBusy(true)
    setError(null)
    try {
      const found = await srvCandidates(email)
      if (!found.length) {
        setError(t('login.noSrvRecord'))
        return
      }
      await connect(found)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-canvas p-4">
      <form
        onSubmit={submit}
        className="animate-rise w-full max-w-sm space-y-4 rounded-panel bg-surface p-6 shadow-panel ring-1 ring-line"
      >
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-control bg-accent text-accent-ink shadow-raised">
            <Icon name="mail" size={17} />
          </span>
          <div>
            <h1 className="text-lg leading-tight font-semibold">{t('login.title')}</h1>
            <p className="text-xs text-ink-subtle">{t('login.subtitle')}</p>
          </div>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink-muted">{t('login.email')}</span>
          <input
            className={inputClass}
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              setNotFound(false)
            }}
            placeholder="you@example.com"
            autoComplete="username"
            required
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink-muted">
            {method === 'basic' ? t('login.password') : t('login.apiToken')}
          </span>
          <input
            className={inputClass}
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && (
          <p className="rounded-control bg-danger-wash px-3 py-2 text-sm text-danger">{error}</p>
        )}

        {notFound && (
          <div className="space-y-3 rounded-control bg-surface-2 p-3">
            <p className="text-xs text-ink-muted">{t('login.notFoundHelp')}</p>

            <button
              type="button"
              disabled={busy}
              onClick={() => void lookupViaDns()}
              className={`w-full ${secondaryButtonClass}`}
            >
              {t('login.tryDns')}
            </button>
            <p className="text-xs text-ink-subtle">{t('login.tryDns.privacy')}</p>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-ink-muted">{t('login.server')}</span>
              <input
                className={inputClass}
                value={manualServer}
                onChange={(e) => setManualServer(e.target.value)}
                placeholder={t('login.serverPlaceholder')}
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-ink-muted">{t('login.auth')}</span>
              <select
                className={inputClass}
                value={method}
                onChange={(e) => setMethod(e.target.value as AuthMethod)}
              >
                <option value="basic">{t('login.auth.basic')}</option>
                <option value="bearer">{t('login.auth.bearer')}</option>
              </select>
            </label>
          </div>
        )}

        <button type="submit" disabled={busy} className={`w-full ${primaryButtonClass}`}>
          {busy ? t('login.connecting') : t('login.connect')}
        </button>
      </form>
    </div>
  )
}
