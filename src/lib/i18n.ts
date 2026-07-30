// Lightweight typed i18n: English is the source of truth, other locales
// override. Locale is resolved once at startup (navigator.language, overridable
// via localStorage 'mel:lang'); a runtime switcher can come with settings.

const en = {
  'app.mail': 'Mail',
  'app.calendar': 'Calendar',
  'app.contacts': 'Contacts',
  'app.comingSoon.calendar': 'Calendar — coming in a later phase',
  'app.comingSoon.contacts': 'Contacts — coming in a later phase',
  'theme.title': 'Theme',

  'login.title': 'Add account',
  'login.preset.custom': 'Other server',
  'login.server': 'Server or email address',
  'login.serverPlaceholder': 'mail.example.com or you@example.com',
  'login.auth': 'Sign-in method',
  'login.auth.basic': 'Username + password',
  'login.auth.bearer': 'API token',
  'login.username': 'Username',
  'login.password': 'Password',
  'login.apiToken': 'API token',
  'login.connect': 'Connect',
  'login.connecting': 'Connecting…',
  'login.failed': 'Sign-in failed',
  'login.noMailAccount': 'Server reports no mail account',

  'mail.refresh': 'Refresh',
  'mail.syncing': 'Syncing…',
  'mail.noMessages': 'No messages',
  'mail.selectMessage': 'Select a message to read',
  'mail.noSubject': '(no subject)',
  'mail.unknownSender': '(unknown)',
  'mail.back': 'Back',
  'mail.loading': 'Loading…',
  'mail.loadError': 'Could not load this message',
  'mail.notFound': 'Message not found',
  'mail.attachment': 'attachment',
  'mail.attachments': 'attachments',
  'mail.attachmentsSoon': 'download coming soon',
  'mail.from': 'From',
  'mail.to': 'To',
  'mail.cc': 'Cc',
  'mail.messageFrame': 'Message content',
} as const

export type MsgKey = keyof typeof en

const de: Partial<Record<MsgKey, string>> = {
  'app.calendar': 'Kalender',
  'app.contacts': 'Kontakte',
  'app.comingSoon.calendar': 'Kalender — kommt in einer späteren Phase',
  'app.comingSoon.contacts': 'Kontakte — kommen in einer späteren Phase',
  'theme.title': 'Design',

  'login.title': 'Konto hinzufügen',
  'login.preset.custom': 'Anderer Server',
  'login.server': 'Server oder E-Mail-Adresse',
  'login.serverPlaceholder': 'mail.example.com oder du@example.com',
  'login.auth': 'Anmeldung',
  'login.auth.basic': 'Benutzername + Passwort',
  'login.auth.bearer': 'API-Token',
  'login.username': 'Benutzername',
  'login.password': 'Passwort',
  'login.apiToken': 'API-Token',
  'login.connect': 'Verbinden',
  'login.connecting': 'Verbinde…',
  'login.failed': 'Anmeldung fehlgeschlagen',
  'login.noMailAccount': 'Server meldet keinen Mail-Account',

  'mail.refresh': 'Aktualisieren',
  'mail.syncing': 'Synchronisiere…',
  'mail.noMessages': 'Keine Nachrichten',
  'mail.selectMessage': 'Wähle eine Nachricht',
  'mail.noSubject': '(kein Betreff)',
  'mail.unknownSender': '(unbekannt)',
  'mail.back': 'Zurück',
  'mail.loading': 'Lade…',
  'mail.loadError': 'Nachricht konnte nicht geladen werden',
  'mail.notFound': 'Nachricht nicht gefunden',
  'mail.attachment': 'Anhang',
  'mail.attachments': 'Anhänge',
  'mail.attachmentsSoon': 'Download folgt',
  'mail.from': 'Von',
  'mail.to': 'An',
  'mail.cc': 'Cc',
  'mail.messageFrame': 'Nachrichteninhalt',
}

const locales: Record<string, Partial<Record<MsgKey, string>>> = { de }

function resolveLocale(): string {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('mel:lang') : null
  const raw = stored ?? (typeof navigator !== 'undefined' ? navigator.language : 'en')
  const short = raw.slice(0, 2).toLowerCase()
  return short in locales ? short : 'en'
}

export const currentLocale = resolveLocale()

export function t(key: MsgKey): string {
  if (currentLocale !== 'en') {
    const v = locales[currentLocale]?.[key]
    if (v !== undefined) return v
  }
  return en[key]
}
