import type { EmailHeader } from '../domain/email'
import type { EmailRow } from './db'
import { sealPlain } from './envelope'

/*
 * IndexedDB cannot sort a multiEntry `*mailboxIds` query by `receivedAt`, so
 * listing a folder in date order used to mean reading the account's whole date
 * index and intersecting it with the folder — work that scaled with the
 * account rather than with the folder, and that an empty folder paid in full.
 *
 * `mailboxDates` is that missing compound index, derived: one entry per
 * mailbox the message is in, carrying the mailbox and the timestamp in a
 * single string. A prefix range over it hands back one folder's ids already in
 * order, from one indexed read.
 *
 * The timestamp is stored *inverted* and zero-padded to a fixed width, because
 * only an ascending scan is cheap (see the `getAllKeys` note in
 * gotchas-dexie-performance.md): inverted, ascending key order *is* newest
 * first. 13 digits covers epoch milliseconds into the year 2286.
 *
 * The separator is NUL rather than a printable character: a mailbox id that
 * happened to contain the separator would otherwise fall inside another
 * mailbox's prefix range. The key stays plaintext-safe — an id and a
 * timestamp, which is what index columns are allowed to hold.
 */
const MAX_TIME = 9_999_999_999_999
const SEP = '\u0000'
const RANGE_END = '\uffff'

/*
 * The thread rides along as a third segment. It changes nothing about the
 * order — the timestamp in front of it decides that — but it means a cursor
 * over the folder's range reports which conversation each message belongs to
 * without reading a single record. That is what lets the grouped list build
 * its window without an account-wide pass (see `readThreadWindow`).
 */
export function mailboxDateKey(mailboxId: string, receivedAt: number, threadId: string): string {
  const at = Number.isFinite(receivedAt) ? Math.min(Math.max(receivedAt, 0), MAX_TIME) : 0
  return `${mailboxId}${SEP}${String(MAX_TIME - at).padStart(13, '0')}${SEP}${threadId}`
}

/** The thread out of a key this module wrote. */
export function threadOfKey(key: string): string | null {
  const at = key.indexOf(SEP, key.indexOf(SEP) + 1)
  return at === -1 ? null : key.slice(at + 1)
}

/** The prefix range that lists one folder, newest first. */
export function mailboxDateRange(mailboxId: string): [string, string] {
  return [`${mailboxId}${SEP}`, `${mailboxId}${SEP}${RANGE_END}`]
}

/**
 * The one place an email row is built from its header.
 *
 * It used to be four, copied apart: sync, the two optimistic patch helpers and
 * search. A derived index column is only as good as the least careful writer,
 * so there is one writer.
 */
export function toEmailRow(accountId: string, h: EmailHeader): EmailRow {
  const mailboxIds = Object.keys(h.mailboxIds)
  const receivedAt = Date.parse(h.receivedAt)
  return {
    accountId,
    id: h.id,
    threadId: h.threadId,
    mailboxIds,
    mailboxDates: mailboxIds.map((m) => mailboxDateKey(m, receivedAt, h.threadId)),
    receivedAt,
    unread: h.keywords['$seen'] ? 0 : 1,
    flagged: h.keywords['$flagged'] ? 1 : 0,
    payload: sealPlain(h),
  }
}
