import { useState } from 'react'
import { t } from '../lib/i18n'
import { unlockAccount } from '../services/encryption'
import { Icon } from '../ui/Icon'
import { inputClass, primaryButtonClass } from '../ui/styles'
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
    <div className="flex h-full items-center justify-center bg-canvas p-4">
      <form
        onSubmit={submit}
        className="animate-rise w-full max-w-xs space-y-4 rounded-panel bg-surface p-6 text-center shadow-panel ring-1 ring-line"
      >
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent text-accent-ink shadow-raised">
          <Icon name="lock" size={22} />
        </span>
        <h1 className="text-lg font-semibold">{t('crypto.unlockTitle')}</h1>
        <input
          type="password"
          autoFocus
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder={t('crypto.passphrase')}
          className={inputClass}
        />
        {error && <p className="text-sm text-danger">{t('crypto.wrongPassphrase')}</p>}
        <button
          type="submit"
          disabled={busy || !passphrase}
          className={`w-full ${primaryButtonClass}`}
        >
          {t('crypto.unlock')}
        </button>
      </form>
    </div>
  )
}
