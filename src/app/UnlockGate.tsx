import { useState } from 'react'
import { t } from '../lib/i18n'
import { unlockAccount } from '../services/encryption'
import { Icon } from '../ui/Icon'
import { useUi } from './store'

export function UnlockGate({ accountIds }: { accountIds: string[] }) {
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const bumpUnlock = useUi((s) => s.bumpUnlock)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(false)
    let allOk = true
    for (const id of accountIds) {
      if (!(await unlockAccount(id, passphrase))) allOk = false
    }
    setBusy(false)
    if (allOk) bumpUnlock()
    else setError(true)
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-xs space-y-4 rounded-2xl border border-line bg-surface p-6 text-center shadow-sm"
      >
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent text-accent-ink">
          <Icon name="lock" size={22} />
        </span>
        <h1 className="text-lg font-semibold">{t('crypto.unlockTitle')}</h1>
        <input
          type="password"
          autoFocus
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder={t('crypto.passphrase')}
          className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />
        {error && <p className="text-sm text-danger">{t('crypto.wrongPassphrase')}</p>}
        <button
          type="submit"
          disabled={busy || !passphrase}
          className="w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-accent-ink disabled:opacity-50"
        >
          {t('crypto.unlock')}
        </button>
      </form>
    </div>
  )
}
