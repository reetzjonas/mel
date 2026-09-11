import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { openEnvelope, sealPlain } from './envelope'
import type { EmailHeader } from '../domain/email'

const header: EmailHeader = {
  id: 'e1',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: {},
  from: [{ name: 'Alice', email: 'alice@localhost' }],
  to: [{ name: null, email: 'bob@localhost' }],
  cc: [],
  subject: 'Hallo',
  receivedAt: '2026-07-30T10:00:00Z',
  sentAt: null,
  preview: 'Hallo Bob',
  hasAttachment: false,
  size: 1234,
}

describe('MelDb', () => {
  beforeEach(async () => {
    await db.emails.clear()
  })

  it('stores and retrieves an email row via the payload envelope', async () => {
    await db.emails.put({
      accountId: 'a1',
      id: header.id,
      threadId: header.threadId,
      mailboxIds: Object.keys(header.mailboxIds),
      mailboxDates: [],
      receivedAt: Date.parse(header.receivedAt),
      unread: 1,
      flagged: 0,
      payload: sealPlain(header),
    })

    const row = await db.emails.get(['a1', 'e1'])
    expect(row).toBeDefined()
    expect(openEnvelope(row!.payload).subject).toBe('Hallo')
  })

  it('queries by multiEntry mailbox index', async () => {
    await db.emails.put({
      accountId: 'a1',
      id: 'e2',
      threadId: 't2',
      mailboxIds: ['inbox', 'archive'],
      mailboxDates: [],
      receivedAt: Date.now(),
      unread: 0,
      flagged: 0,
      payload: sealPlain({ ...header, id: 'e2', threadId: 't2' }),
    })

    const rows = await db.emails.where('mailboxIds').equals('archive').toArray()
    expect(rows.map((r) => r.id)).toEqual(['e2'])
  })

  it('rejects reading an encrypted envelope without crypto layer', () => {
    expect(() =>
      openEnvelope({ enc: { v: 1, iv: new Uint8Array(12), ct: new Uint8Array(0) } }),
    ).toThrow(/encrypted/)
  })
})
