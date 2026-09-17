// Normalized contact model (from JSContact, RFC 9553 / RFC 9610).

export interface AddressBook {
  id: string
  name: string
  isDefault: boolean
  mayWrite: boolean
  mayDelete: boolean
}

export interface LabeledValue {
  value: string
  /** work / home / other. */
  label: string | null
}

/**
 * A handle on some service — Mastodon, Matrix, Signal — as JSContact carries it.
 *
 * Three fields rather than a LabeledValue because the card separates the name
 * of the service, the handle as written, and where that handle opens; folding
 * them into one value would throw away whichever half was not shown.
 */
export interface OnlineService {
  /** As the card names it, e.g. "Mastodon". */
  service: string
  /** The handle as written, e.g. "@erika@chaos.social". */
  user: string
  /** Where it opens, when the card carries one. */
  uri: string
}

export interface PostalAddress {
  /** Free-form full address (JSContact address "full" or joined components). */
  full: string
  label: string | null
}

export interface Contact {
  id: string
  addressBookIds: Record<string, true>
  kind: 'individual' | 'group' | 'org' | 'other'
  fullName: string
  given: string
  surname: string
  nickname: string
  organization: string
  jobTitle: string
  emails: LabeledValue[]
  phones: LabeledValue[]
  addresses: PostalAddress[]
  urls: LabeledValue[]
  onlineServices: OnlineService[]
  /** Free-form tags the card carries, for grouping and filtering. */
  keywords: string[]
  /**
   * The contact's picture as a URI, '' when the card has none.
   *
   * A URI rather than a blob id because that is all the card can hold: the
   * picture mel uploads is a `data:` URI it scaled down itself, and one that
   * arrived from elsewhere may be an `https:` URL instead.
   */
  photo: string
  /**
   * Birthday as `YYYY-MM-DD`, or `--MM-DD` when the card gives no year, which
   * is how a great many of them arrive. '' when the card has none.
   */
  birthday: string
  note: string
  /** For kind=group: member uids. */
  memberUids: string[]
}

/**
 * A stored card, with whatever the model gained after it was written filled in.
 *
 * Rows are written by the version of mel that was installed at the time and
 * are not migrated, so a card saved before handles, tags, a picture or a
 * birthday existed simply has no such key. The first `.trim()` or `.map()`
 * over one throws and takes the screen with it — which is what a missing
 * `birthday` did to the whole calendar, since it builds birthday events out of
 * every card. A later sync rewrites the row; this carries it until then.
 */
export function storedContact(stored: Contact): Contact {
  return {
    ...stored,
    kind: stored.kind ?? 'individual',
    fullName: stored.fullName ?? '',
    given: stored.given ?? '',
    surname: stored.surname ?? '',
    nickname: stored.nickname ?? '',
    organization: stored.organization ?? '',
    jobTitle: stored.jobTitle ?? '',
    emails: stored.emails ?? [],
    phones: stored.phones ?? [],
    addresses: stored.addresses ?? [],
    urls: stored.urls ?? [],
    onlineServices: stored.onlineServices ?? [],
    keywords: stored.keywords ?? [],
    photo: stored.photo ?? '',
    birthday: stored.birthday ?? '',
    note: stored.note ?? '',
    memberUids: stored.memberUids ?? [],
  }
}

export function displayName(c: Contact): string {
  return (
    c.fullName ||
    [c.given, c.surname].filter(Boolean).join(' ') ||
    c.organization ||
    c.emails[0]?.value ||
    '—'
  )
}

/**
 * Sort key: matches the display name (given-name first), so the list order
 * and its letter group headers agree.
 */
export function contactSortKey(c: Contact): string {
  return displayName(c).toLowerCase()
}

/**
 * A blank card, for the editor to fill in.
 *
 * Here rather than beside the editor: it describes what a contact *is* when
 * it has nothing in it yet, which is a fact about the domain and not about
 * the form that happens to collect it.
 */
export function emptyContact(addressBookId: string): Contact {
  return {
    id: '',
    addressBookIds: { [addressBookId]: true },
    kind: 'individual',
    fullName: '',
    given: '',
    surname: '',
    nickname: '',
    organization: '',
    jobTitle: '',
    emails: [{ value: '', label: null }],
    phones: [],
    addresses: [],
    urls: [],
    onlineServices: [],
    keywords: [],
    photo: '',
    birthday: '',
    note: '',
    memberUids: [],
  }
}

/** The day and month of a birthday, or null when it is not a date we can read. */
export function birthdayMonthDay(birthday: string): { month: number; day: number } | null {
  const m = /^(?:(\d{4})|-)?-(\d{2})-(\d{2})$/.exec(birthday.trim())
  if (!m) return null
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { month, day }
}

/** The year a birthday names, or null when it names none. */
export function birthdayYear(birthday: string): number | null {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(birthday.trim())
  return m ? Number(m[1]) : null
}
