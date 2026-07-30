import { useState } from 'react'
import type { AuthMethod } from '../../domain/account'
import { t } from '../../lib/i18n'
import { addAccount } from '../../services/accounts'
import { Icon } from '../../ui/Icon'

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

  const input =
    'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors focus:border-accent'

  return (
    <div className="flex h-full items-center justify-center bg-bg p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-sm"
      >
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <Icon name="mail" size={16} />
          </span>
          <h1 className="text-lg font-semibold">{t('login.title')}</h1>
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
              className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${preset.id === p.id ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-ink-muted hover:text-ink'}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink-muted">{t('login.server')}</span>
          <input
            className={input}
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder={t('login.serverPlaceholder')}
            required
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink-muted">{t('login.auth')}</span>
          <select
            className={input}
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
              className={input}
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
            className={input}
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && <p className="text-sm text-danger">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? t('login.connecting') : t('login.connect')}
        </button>
      </form>
    </div>
  )
}
