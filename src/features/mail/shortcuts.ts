import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useUi } from '../../app/store'
import type { Mailbox } from '../../domain/mailbox'
import { t } from '../../lib/i18n'
import { bulkArchive, bulkDelete, markRead, setKeyword } from '../../services/mailActions'
import { buildReply } from '../../services/send'
import { db } from '../../storage/db'
import { openEnvelope } from '../../storage/envelope'

interface Ctx {
  accountId: string | undefined
  ownEmail: string | undefined
  mailboxId: string | undefined
  emailId: string | undefined
  mailboxes: Mailbox[] | undefined
}

const CHORD_MS = 600

export function useMailShortcuts(ctx: Ctx) {
  const navigate = useNavigate()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const lastG = useRef(0)

  useEffect(() => {
    async function handle(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.target instanceof HTMLElement) {
        if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return
      }
      const { accountId, ownEmail, mailboxId, emailId, mailboxes } = ctxRef.current
      const ui = useUi.getState()
      // Anything modal swallows them: a single key acting on the message behind
      // an open dialog is never what the keypress meant.
      if (ui.compose || ui.messageDetailsOpen || ui.helpOpen) return

      const backToList = () => {
        if (mailboxId) void navigate({ to: '/mail/$mailboxId', params: { mailboxId } })
      }

      switch (e.key) {
        case 'c':
          ui.openCompose({})
          return
        case '/':
          e.preventDefault()
          document.getElementById('mail-search')?.focus()
          return
        case '?':
          ui.setHelpOpen(true)
          return
        case 'g':
          lastG.current = Date.now()
          return
        case 'i': {
          if (Date.now() - lastG.current > CHORD_MS) return
          const inbox = mailboxes?.find((m) => m.role === 'inbox')
          if (inbox) void navigate({ to: '/mail/$mailboxId', params: { mailboxId: inbox.id } })
          return
        }
      }

      if (!accountId || !emailId) return
      switch (e.key) {
        // Archive and delete take the one message the URL names — the same
        // default the reading pane's buttons have. Taking the whole
        // conversation is a deliberate pick from the caret beside them, and a
        // single key that quietly did the wider thing would be worse than no
        // shortcut at all.
        case 'e': {
          const undo = await bulkArchive(accountId, [emailId])
          backToList()
          // null means no Archive mailbox could be created. Staying quiet here
          // looks exactly like success while nothing has moved at all.
          ui.showSnackbar(
            undo
              ? {
                  message: t('mail.archived'),
                  actionLabel: t('mail.undo'),
                  action: () => void undo(),
                }
              : { message: t('mail.archiveFailed') },
          )
          return
        }
        case '#': {
          const undo = await bulkDelete(accountId, [emailId])
          backToList()
          ui.showSnackbar(
            undo
              ? {
                  message: t('mail.deleted'),
                  actionLabel: t('mail.undo'),
                  action: () => void undo(),
                }
              : { message: t('mail.deleted') },
          )
          return
        }
        case 's': {
          const row = await db.emails.get([accountId, emailId])
          if (!row) return
          const flagged = Boolean(openEnvelope(row.payload).keywords['$flagged'])
          void setKeyword(accountId, emailId, '$flagged', !flagged)
          return
        }
        case 'u':
          void markRead(accountId, emailId, false)
          backToList()
          return
        case 'r':
        case 'a':
        case 'f': {
          const row = await db.emails.get([accountId, emailId])
          if (!row) return
          const header = openEnvelope(row.payload)
          const bodyRow = await db.bodyCache.get([accountId, emailId])
          const body = bodyRow ? openEnvelope(bodyRow.payload) : null
          const mode = e.key === 'r' ? 'reply' : e.key === 'a' ? 'replyAll' : 'forward'
          ui.openCompose(buildReply(accountId, header, body, mode, ownEmail ?? ''))
          return
        }
      }
    }

    const listener = (e: KeyboardEvent) => void handle(e)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [navigate])
}
