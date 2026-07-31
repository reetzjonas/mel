import { useState } from 'react'
import type { AuthMethod } from '../../domain/account'
import { t } from '../../lib/i18n'
import { addAccount } from '../../services/accounts'
import { Icon } from '../../ui/Icon'
import { inputClass, primaryButtonClass } from '../../ui/styles'

const presets = [
  {
    id: 'stalwart',
    label: 'Stalwart (local)',
    server: 'http://localhost:8080/.well-known/jmap',
    method: 'basic' as AuthMethod,
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    server: 'https://api.fastmail.com/jmap/session',
    method: 'bearer' as AuthMethod,
  },
  { id: 'custom', label: t('login.preset.custom'), server: '', method: 'basic' as AuthMethod },
]

export function AddAccountForm({ onDone }: { onDone: (accountId: string) => void }) {
  const [preset, setPreset] = useState(presets[0]!)
  const [server, setServer] = useState(presets[0]!.server)
  const [method, setMethod] = useState<AuthMethod>('basic')
  const [username, setUsername] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const id = await addAccount(server, {
        method,
        username: method === 'basic' ? username : undefined,
        secret,
      })
      onDone(id)
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

        <div className="flex gap-1.5">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setPreset(p)
                setServer(p.server)
                setMethod(p.method)
              }}
              className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${preset.id === p.id ? 'bg-accent text-accent-ink shadow-raised' : 'bg-surface-2 text-ink-muted hover:text-ink'}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink-muted">{t('login.server')}</span>
          <input
            className={inputClass}
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder={t('login.serverPlaceholder')}
            required
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

        {method === 'basic' && (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-ink-muted">{t('login.username')}</span>
            <input
              className={inputClass}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="alice@localhost"
              autoComplete="username"
              required
            />
          </label>
        )}

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

        <button type="submit" disabled={busy} className={`w-full ${primaryButtonClass}`}>
          {busy ? t('login.connecting') : t('login.connect')}
        </button>
      </form>
    </div>
  )
}
