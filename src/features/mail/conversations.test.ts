import { describe, expect, it } from 'vitest'
import type { EmailHeader } from '../../domain/email'
import { buildConversations } from './conversations'

const INBOX = 'mb-inbox'
const SENT = 'mb-sent'
const TRASH = 'mb-trash'

function header(
  id: string,
  iso: string,
  mailboxIds: string[],
  extra: Partial<EmailHeader> = {},
): EmailHeader {
  const map: Record<string, true> = {}
  for (const m of mailboxIds) map[m] = true
  return {
    id,
    threadId: 't1',
    mailboxIds: map,
    keywords: {},
    from: [{ name: 'Anna', email: 'anna@example.com' }],
    to: [],
    cc: [],
    subject: id,
    receivedAt: iso,
    sentAt: null,
    preview: '',
    hasAttachment: false,
    size: 0,
    ...extra,
  }
}

/** The two maps the hook feeds in, derived from the headers under test. */
function inputs(headers: EmailHeader[]) {
  const members = new Map<string, string[]>()
  const byId = new Map<string, EmailHeader>()
  for (const h of headers) {
    byId.set(h.id, h)
    const list = members.get(h.threadId)
    if (list) list.push(h.id)
    else members.set(h.threadId, [h.id])
  }
  return { members, headers: byId, threadIds: [...members.keys()] }
}

describe('buildConversations', () => {
  it('counts the whole thread but acts only on this mailbox', () => {
    const headers = [
      header('in-1', '2026-01-01T10:00:00.000Z', [INBOX]),
      header('out-1', '2026-01-01T11:00:00.000Z', [SENT], {
        from: [{ name: 'Me', email: 'me@example.com' }],
      }),
      header('in-2', '2026-01-01T12:00:00.000Z', [INBOX]),
    ]
    const [conversation] = buildConversations({
      ...inputs(headers),
      mailboxId: INBOX,
      filter: undefined,
    })

    expect(conversation?.messages.map((m) => m.id)).toEqual(['in-1', 'out-1', 'in-2'])
    // The reply in Sent is part of the exchange, but archiving the inbox row
    // must not reach into Sent.
    expect(conversation?.ids).toEqual(['in-1', 'in-2'])
    expect(conversation?.latest.id).toBe('in-2')
    expect(conversation?.participants.map((p) => p.email)).toEqual([
      'anna@example.com',
      'me@example.com',
    ])
  })

  it('leaves out messages that only live in trash or junk', () => {
    const headers = [
      header('kept', '2026-01-01T10:00:00.000Z', [INBOX]),
      header('binned', '2026-01-01T11:00:00.000Z', [TRASH]),
    ]
    const [conversation] = buildConversations({
      ...inputs(headers),
      mailboxId: INBOX,
      filter: undefined,
      excludedMailboxIds: new Set([TRASH]),
    })

    // A message you deleted must not go on padding the row you deleted it from.
    expect(conversation?.messages.map((m) => m.id)).toEqual(['kept'])
  })

  it('shows the trashed message again when trash is the folder being listed', () => {
    const headers = [
      header('kept', '2026-01-01T10:00:00.000Z', [INBOX]),
      header('binned', '2026-01-01T11:00:00.000Z', [TRASH]),
    ]
    // The hook drops the listed mailbox from the exclusion set, so trash lists
    // its own contents.
    const [conversation] = buildConversations({
      ...inputs(headers),
      mailboxId: TRASH,
      filter: undefined,
      excludedMailboxIds: new Set(),
    })

    expect(conversation?.ids).toEqual(['binned'])
  })

  it('skips a thread whose messages have all left the mailbox', () => {
    const headers = [header('moved', '2026-01-01T10:00:00.000Z', [SENT])]
    expect(buildConversations({ ...inputs(headers), mailboxId: INBOX, filter: undefined })).toEqual(
      [],
    )
  })

  it('skips a thread that is not materialised yet rather than half-rendering it', () => {
    const members = new Map([['t1', ['not-loaded']]])
    expect(
      buildConversations({
        threadIds: ['t1'],
        members,
        headers: new Map(),
        mailboxId: INBOX,
        filter: undefined,
      }),
    ).toEqual([])
  })

  it('aggregates unread and flagged over this mailbox only', () => {
    const headers = [
      header('read-here', '2026-01-01T10:00:00.000Z', [INBOX], { keywords: { $seen: true } }),
      // Unread, but sitting in another folder: nothing in this row would clear
      // it, so the row must not claim to be unread.
      header('unread-elsewhere', '2026-01-01T11:00:00.000Z', [SENT]),
    ]
    const [conversation] = buildConversations({
      ...inputs(headers),
      mailboxId: INBOX,
      filter: undefined,
    })

    expect(conversation?.unread).toBe(false)
    expect(conversation?.messages).toHaveLength(2)
  })

  it('stands the row on the newest message that matches the filter', () => {
    const headers = [
      header('old-unread', '2026-01-01T10:00:00.000Z', [INBOX]),
      header('new-read', '2026-01-01T12:00:00.000Z', [INBOX], { keywords: { $seen: true } }),
    ]
    const [conversation] = buildConversations({
      ...inputs(headers),
      mailboxId: INBOX,
      filter: 'unread',
    })

    expect(conversation?.latest.id).toBe('old-unread')
    expect(conversation?.ids).toEqual(['old-unread'])
    // The count still describes the conversation, not the filter.
    expect(conversation?.messages).toHaveLength(2)
  })

  it('keeps the thread order it is given', () => {
    const headers = [
      header('a', '2026-01-01T10:00:00.000Z', [INBOX], { threadId: 'ta' }),
      header('b', '2026-01-02T10:00:00.000Z', [INBOX], { threadId: 'tb' }),
    ]
    const built = buildConversations({
      ...inputs(headers),
      threadIds: ['tb', 'ta'],
      mailboxId: INBOX,
      filter: undefined,
    })
    expect(built.map((c) => c.threadId)).toEqual(['tb', 'ta'])
  })
})
