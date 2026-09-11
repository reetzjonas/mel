/*
 * Settings as a modal over whatever the user was looking at, rather than a
 * screen they have to navigate back out of. The open tab lives in the URL
 * (`?settings=<tab>`), so the back button closes the dialog and the sync bar
 * can still link straight at the capability list.
 */
import { useEffect } from 'react'
import { useAccounts } from '../mail/hooks'
import { t, type MsgKey } from '../../lib/i18n'
import { Icon } from '../../ui/Icon'
import { overlayPanelClass, scrimClass } from '../../ui/styles'
import { OutboxQueue } from './OutboxQueue'
import { ServerCapabilities } from './ServerCapabilities'
import { settingsTabs, type SettingsTab } from './tabs'
import {
  AccountSetting,
  ConversationSetting,
  EncryptionSetting,
  ImageSetting,
  LanguageSetting,
  NotificationSetting,
  Section,
  ThemeSetting,
  VacationSetting,
  WebPushSetting,
} from './sections'

const tabLabels: Record<SettingsTab, MsgKey> = {
  general: 'settings.tab.general',
  mail: 'settings.tab.mail',
  notifications: 'settings.tab.notifications',
  security: 'settings.tab.security',
  account: 'settings.tab.account',
}

/**
 * A tab whose only contents are gated away would open onto nothing, so the tab
 * itself has to go. Encryption and everything under Account need an account;
 * the rest work on a bare browser profile.
 */
function visibleTabs(hasAccount: boolean): readonly SettingsTab[] {
  return settingsTabs.filter((tab) => hasAccount || (tab !== 'security' && tab !== 'account'))
}

export function SettingsDialog({
  tab,
  onTab,
  onClose,
}: {
  tab: SettingsTab
  onTab: (tab: SettingsTab) => void
  onClose: () => void
}) {
  const accounts = useAccounts()
  const account = accounts?.[0]
  // The account arrives a tick after the dialog does. Assuming one exists
  // until proven otherwise keeps a deep link to an account tab from being
  // rewritten to the first tab in that gap — the correction below would fire
  // on the empty first render and the address bar would lose the tab.
  const tabs = visibleTabs(accounts === undefined || Boolean(account))
  const active = tabs.includes(tab) ? tab : (tabs[0] ?? 'general')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // A deep link to a tab that this account cannot show (or signing out while
  // standing on one) leaves the URL lying; correct it rather than silently
  // showing a different tab than the address bar claims.
  useEffect(() => {
    if (active !== tab) onTab(active)
  }, [active, tab, onTab])

  return (
    <div className={`${scrimClass} z-50 flex items-center justify-center sm:p-4`} onClick={onClose}>
      {/*
       * Fixed size rather than one that follows the content: tabs differ a lot
       * in length, and a panel that jumps between them reads as hectic. Same
       * reasoning as the height-neutral hover swap in the folder list — the
       * frame stays put, only what is inside it scrolls.
       */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        className={`animate-rise flex h-full w-full flex-col sm:h-[min(85vh,38rem)] sm:max-w-4xl ${overlayPanelClass} rounded-none sm:rounded-panel`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 px-4 pt-4 pb-2 sm:px-5">
          <h1 className="text-lg font-semibold">{t('settings.title')}</h1>
          <button
            type="button"
            aria-label={t('settings.close')}
            onClick={onClose}
            className="ml-auto rounded-control p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="close" />
          </button>
        </header>

        {/*
         * The tabs become a rail down the side once there is room for one. A
         * landscape panel with the tabs still on top would stretch every select
         * across its full width; beside the content, the width goes into the
         * things that can use it (the capability list, the queue, the vacation
         * text) instead.
         */}
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <div
            role="tablist"
            aria-label={t('settings.title')}
            aria-orientation="vertical"
            className="flex shrink-0 gap-1 overflow-x-auto px-4 pb-2 sm:w-48 sm:flex-col sm:overflow-x-visible sm:overflow-y-auto sm:px-3 sm:pb-3"
          >
            {tabs.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`settings-tab-${id}`}
                aria-selected={id === active}
                aria-controls={`settings-panel-${id}`}
                onClick={() => onTab(id)}
                className={
                  id === active
                    ? 'shrink-0 rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-ink shadow-raised sm:w-full sm:text-left'
                    : 'shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium text-ink-muted transition-[color,background-color] duration-150 hover:bg-surface-2 hover:text-ink sm:w-full sm:text-left'
                }
              >
                {t(tabLabels[id])}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`settings-panel-${active}`}
            aria-labelledby={`settings-tab-${active}`}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-canvas p-4 sm:rounded-br-panel sm:p-5"
          >
            {active === 'general' && (
              <>
                <Section title={t('settings.language')}>
                  <LanguageSetting />
                </Section>
                <Section title={t('settings.theme')}>
                  <ThemeSetting />
                </Section>
              </>
            )}

            {active === 'mail' && (
              <>
                <Section title={t('settings.conversations')}>
                  <ConversationSetting />
                </Section>
                <Section title={t('settings.privacy')}>
                  <ImageSetting />
                </Section>
                {account?.capabilities.vacation && (
                  <Section title={t('settings.vacation')}>
                    <VacationSetting accountId={account.id} />
                  </Section>
                )}
              </>
            )}

            {active === 'notifications' && (
              <>
                <Section title={t('settings.notifications')}>
                  <NotificationSetting />
                </Section>
                {account && (
                  <Section title={t('push.section')}>
                    <WebPushSetting accountId={account.id} />
                  </Section>
                )}
              </>
            )}

            {active === 'security' && account && (
              <Section title={t('crypto.section')}>
                <EncryptionSetting accountId={account.id} />
              </Section>
            )}

            {active === 'account' && account && (
              <>
                <Section title={t('settings.account')}>
                  <AccountSetting account={account} onDone={onClose} />
                </Section>
                <Section title={t('queue.section')}>
                  <OutboxQueue accountId={account.id} />
                </Section>
                <Section title={t('settings.server')}>
                  <ServerCapabilities account={account} />
                </Section>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
