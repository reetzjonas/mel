/*
 * Settings as a modal over whatever the user was looking at, rather than a
 * screen they have to navigate back out of. The open tab lives in the URL
 * (`?settings=<tab>`), so the back button closes the dialog and the sync bar
 * can still link straight at the capability list.
 */
import { useEffect, useRef } from 'react'
import { useAccounts } from '../mail/hooks'
import { t, type MsgKey } from '../../lib/i18n'
import { DialogHeader } from '../../ui/DialogHeader'
import { overlayPanelClass, scrimClass } from '../../ui/styles'
import { useMobileViewport, useModal } from '../../ui/useModal'
import { OutboxQueue } from './OutboxQueue'
import { ThemeEditor } from './ThemeEditor'
import { ServerCapabilities } from './ServerCapabilities'
import { anchorId, settingsTabs, type SettingsAnchor, type SettingsTab } from './tabs'
import {
  AccountSetting,
  ConversationSetting,
  EncryptionSetting,
  ImageSetting,
  LanguageSetting,
  PanelWidthSetting,
  NotificationSetting,
  Section,
  SyncSetting,
  ThemeSetting,
  VacationSetting,
  WebPushSetting,
} from './sections'
import { SieveSetting } from './SieveSetting'
import { StorageSetting } from './StorageQuota'

const tabLabels: Record<SettingsTab, MsgKey> = {
  general: 'settings.tab.general',
  appearance: 'settings.tab.appearance',
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
  anchor,
  onTab,
  onClose,
}: {
  tab: SettingsTab
  onTab: (tab: SettingsTab) => void
  onClose: () => void
  anchor?: SettingsAnchor | undefined
}) {
  const accounts = useAccounts()
  const account = accounts?.[0]
  // The account arrives a tick after the dialog does. Assuming one exists
  // until proven otherwise keeps a deep link to an account tab from being
  // rewritten to the first tab in that gap — the correction below would fire
  // on the empty first render and the address bar would lose the tab.
  const tabs = visibleTabs(accounts === undefined || Boolean(account))
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const active = tabs.includes(tab) ? tab : (tabs[0] ?? 'general')
  const mobileViewport = useMobileViewport()
  useModal({ panel: dialogRef, initialFocus: closeRef, onClose })

  // A deep link to a tab that this account cannot show (or signing out while
  // standing on one) leaves the URL lying; correct it rather than silently
  // showing a different tab than the address bar claims.
  useEffect(() => {
    if (active !== tab) onTab(active)
  }, [active, tab, onTab])

  /*
   * Scroll to the section a link asked for.
   *
   * The panel scrolls, not the page, so this is not the browser's own fragment
   * handling. Scrolling once is not enough either: several sections fetch
   * before they have their real height (the vacation response sits *above* the
   * filter rules and roughly triples in size when it lands), so a single scroll
   * lands somewhere that stops being the right place a moment later — measured,
   * not guessed: the panel ended up 28px down from a target 760px in.
   *
   * So it re-applies while the panel keeps changing size, and gives up the
   * moment the reader takes over or a second has passed. Instant rather than
   * smooth: a smooth scroll that gets re-aimed twice reads as drifting.
   */
  useEffect(() => {
    const panel = panelRef.current
    if (!anchor || !panel) return

    let done = false
    const stop = () => {
      done = true
      resize.disconnect()
      clearTimeout(timer)
      for (const event of ['wheel', 'touchstart', 'keydown'] as const)
        panel.removeEventListener(event, stop)
    }
    const reveal = () => {
      if (done) return
      const el = document.getElementById(anchorId(anchor))
      if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' })
    }

    const resize = new ResizeObserver(reveal)
    resize.observe(panel)
    for (const child of panel.children) resize.observe(child)
    // Sections that appear later (their account or fetch arrives) are not
    // covered by the observers above, which only watch what is already there.
    const added = new MutationObserver(() => {
      for (const child of panel.children) resize.observe(child)
      reveal()
    })
    added.observe(panel, { childList: true })

    const timer = setTimeout(stop, 1000)
    for (const event of ['wheel', 'touchstart', 'keydown'] as const)
      panel.addEventListener(event, stop, { passive: true })

    reveal()
    return () => {
      stop()
      added.disconnect()
    }
  }, [anchor, active])

  return (
    <div
      className={`${scrimClass} z-50 flex items-center justify-center sm:p-4`}
      style={mobileViewport ? { bottom: mobileViewport.inset } : undefined}
    >
      {/*
       * Fixed size rather than one that follows the content: tabs differ a lot
       * in length, and a panel that jumps between them reads as hectic. Same
       * reasoning as the height-neutral hover swap in the folder list — the
       * frame stays put, only what is inside it scrolls.
       */}
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        className={`animate-rise flex h-full w-full flex-col sm:h-[min(85vh,38rem)] sm:max-w-4xl ${overlayPanelClass} rounded-none sm:rounded-panel`}
        style={mobileViewport ? { height: `${mobileViewport.height}px` } : undefined}
      >
        <DialogHeader
          title={t('settings.title')}
          closeLabel={t('settings.close')}
          closeRef={closeRef}
          onClose={onClose}
        />

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
                    ? 'shrink-0 rounded-control bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-ink shadow-raised sm:w-full sm:text-left'
                    : 'shrink-0 rounded-control px-3.5 py-1.5 text-[13px] font-medium text-ink-muted transition-[color,background-color] duration-150 hover:bg-surface-2 hover:text-ink sm:w-full sm:text-left'
                }
              >
                {t(tabLabels[id])}
              </button>
            ))}
          </div>

          <div
            ref={panelRef}
            role="tabpanel"
            id={`settings-panel-${active}`}
            aria-labelledby={`settings-tab-${active}`}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-canvas p-4 sm:rounded-br-panel sm:p-5"
          >
            {active === 'general' && (
              <>
                <Section title={t('settings.language')}>
                  <LanguageSetting accountId={account?.id} />
                </Section>
                <Section title={t('settings.sync')}>
                  <SyncSetting hasFiles={account?.capabilities.files ?? false} />
                </Section>
              </>
            )}

            {active === 'appearance' && (
              <>
                <Section title={t('settings.theme')}>
                  <ThemeSetting accountId={account?.id} />
                </Section>
                <Section title={t('settings.colors')}>
                  <ThemeEditor accountId={account?.id} />
                </Section>
                <Section title={t('settings.layout')}>
                  <PanelWidthSetting />
                </Section>
              </>
            )}

            {active === 'mail' && (
              <>
                <Section title={t('settings.conversations')}>
                  <ConversationSetting accountId={account?.id} />
                </Section>
                <Section title={t('settings.privacy')}>
                  <ImageSetting accountId={account?.id} />
                </Section>
                {account?.capabilities.vacation && (
                  <Section title={t('settings.vacation')}>
                    <VacationSetting accountId={account.id} />
                  </Section>
                )}
                {account?.capabilities.sieve && (
                  <Section title={t('settings.sieve')} anchor="sieve">
                    <SieveSetting accountId={account.id} />
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
                <Section title={t('quota.section')} anchor="storage">
                  <StorageSetting accountId={account.id} enabled={account.capabilities.quota} />
                </Section>
                <Section title={t('queue.section')}>
                  <OutboxQueue accountId={account.id} />
                </Section>
                <Section title={t('settings.server')} anchor="capabilities">
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
