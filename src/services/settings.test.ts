import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'

const enqueued: Array<{ kind: string }> = []
vi.mock('../sync/outbox', () => ({
  enqueue: (accountId: string, action: { kind: string }) => {
    enqueued.push(action)
    return db.outbox.add({
      accountId,
      kind: action.kind,
      status: 'pending',
      attempts: 0,
      notBefore: 0,
      payload: sealPlain(action),
    })
  },
}))

const { useUi } = await import('../app/store')
const { setThemeTuning } = await import('../app/themeTuning')
const { applyHiddenCalendarsSilently, hiddenCalendarsKey } = await import('../lib/hiddenCalendars')
const { applySettingsSilently, collectLocalSettings, scheduleSettingsSync } =
  await import('./settings')

const ACC = 'acc-settings'

beforeEach(async () => {
  await db.outbox.clear()
  await db.accounts.clear()
  localStorage.clear()
  enqueued.length = 0
  useUi.setState({ conversationView: true })
  setThemeTuning(null)
})

describe('collectLocalSettings', () => {
  it('reads every synced value fresh from where it actually lives', () => {
    localStorage.setItem('mel:theme', 'dark')
    localStorage.setItem('mel:lang', 'de')
    useUi.getState().setConversationView(false)
    applyHiddenCalendarsSilently(ACC, ['cal-1'])

    const collected = collectLocalSettings(ACC)

    expect(collected).toMatchObject({
      version: 1,
      theme: 'dark',
      lang: 'de',
      conversationView: false,
      hiddenCalendars: ['cal-1'],
    })
  })

  it('answers "system" for an unset theme or language rather than omitting the field', () => {
    const collected = collectLocalSettings(ACC)
    expect(collected.theme).toBe('system')
    expect(collected.lang).toBe('system')
  })
})

describe('applySettingsSilently', () => {
  it('applies every known field', () => {
    applySettingsSilently(ACC, {
      theme: 'dark',
      themeTuning: { accentHue: 10, accentChroma: 1, surfaceHue: 20, surfaceTint: 1 },
      conversationView: false,
      hiddenCalendars: ['cal-9'],
    })

    expect(localStorage.getItem('mel:theme')).toBe('dark')
    expect(useUi.getState().conversationView).toBe(false)
    expect(localStorage.getItem(hiddenCalendarsKey(ACC))).toBe('["cal-9"]')
  })

  it('ignores a field with the wrong shape rather than crashing', () => {
    expect(() =>
      applySettingsSilently(ACC, {
        theme: 'purple', // not a real ThemePreference
        conversationView: 'yes', // not a boolean
        hiddenCalendars: [1, 2], // not strings
      }),
    ).not.toThrow()
    expect(localStorage.getItem('mel:theme')).toBeNull()
    expect(useUi.getState().conversationView).toBe(true) // unchanged
  })

  it('never enqueues a push of its own — applying is not the same as changing', async () => {
    // The regression a design review caught: if applying a remote value went
    // through the same setter a user edit uses, it would also trigger a
    // push, and the very next sync would see that push as a new incoming
    // change — an actual loop. Nothing in this module calls
    // scheduleSettingsSync from inside applySettingsSilently.
    applySettingsSilently(ACC, {
      theme: 'dark',
      themeTuning: { accentHue: 10, accentChroma: 1, surfaceHue: 20, surfaceTint: 1 },
      conversationView: false,
      hiddenCalendars: ['cal-9'],
      lang: 'de',
    })

    expect(enqueued).toEqual([])
    expect(await db.outbox.count()).toBe(0)
  })

  describe('a language change', () => {
    it('writes storage and offers a reload, without reloading itself', () => {
      const show = vi.spyOn(useUi.getState(), 'showSnackbar')

      applySettingsSilently(ACC, { lang: 'de' })

      expect(localStorage.getItem('mel:lang')).toBe('de')
      expect(show).toHaveBeenCalledOnce()
      // The snackbar carries the reload; nothing here calls it directly.
      const call = show.mock.calls[0]![0] as { action?: () => void }
      expect(typeof call.action).toBe('function')
    })

    it('clears the override for "system" the same way the language select does', () => {
      localStorage.setItem('mel:lang', 'de')

      applySettingsSilently(ACC, { lang: 'system' })

      expect(localStorage.getItem('mel:lang')).toBeNull()
    })

    it('says nothing when the value already matches — a re-applied sync is silent', () => {
      localStorage.setItem('mel:lang', 'de')
      const show = vi.spyOn(useUi.getState(), 'showSnackbar')

      applySettingsSilently(ACC, { lang: 'de' })

      expect(show).not.toHaveBeenCalled()
    })
  })
})

describe('scheduleSettingsSync', () => {
  async function putAccount(filesCapability: boolean) {
    await db.accounts.put({
      id: ACC,
      provider: 'jmap',
      encrypted: false,
      payload: sealPlain({
        account: {
          id: ACC,
          provider: 'jmap',
          label: 'a@b.c',
          remoteAccountId: 'r1',
          sessionUrl: 'https://example.test',
          capabilities: {
            mail: true,
            submission: true,
            contacts: true,
            calendars: true,
            calendarCreate: true,
            sieve: false,
            vacation: false,
            files: filesCapability,
            quota: false,
            push: 'poll',
            webPush: false,
          },
          encrypted: false,
        },
        credentials: { method: 'basic', secret: 'x' },
      }),
    })
  }

  it('does nothing for an account with no file storage — the local-only fallback', async () => {
    await putAccount(false)

    await scheduleSettingsSync(ACC, ['theme'])

    expect(await db.outbox.count()).toBe(0)
  })

  it('does nothing for an account it has never heard of', async () => {
    await scheduleSettingsSync(ACC, ['theme'])
    expect(await db.outbox.count()).toBe(0)
  })

  it('queues a push for an account that offers file storage', async () => {
    await putAccount(true)

    await scheduleSettingsSync(ACC, ['theme'])

    expect(await db.outbox.count()).toBe(1)
  })

  it('merges a second field into the still-pending push instead of dropping it', async () => {
    // The bug a bisected e2e failure caught: a plain "one is already
    // pending, skip" check used to discard whichever field came second if
    // two different settings changed within the push delay.
    await putAccount(true)

    await scheduleSettingsSync(ACC, ['theme'])
    await scheduleSettingsSync(ACC, ['conversationView'])

    expect(await db.outbox.count()).toBe(1)
    const [row] = await db.outbox.toArray()
    const action = openEnvelope(row!.payload) as { kind: string; fields: string[] }
    expect(action.fields.sort()).toEqual(['conversationView', 'theme'])
  })

  it('does not duplicate a field named twice in a row', async () => {
    await putAccount(true)

    await scheduleSettingsSync(ACC, ['theme'])
    await scheduleSettingsSync(ACC, ['theme'])

    const [row] = await db.outbox.toArray()
    const action = openEnvelope(row!.payload) as { kind: string; fields: string[] }
    expect(action.fields).toEqual(['theme'])
  })
})
