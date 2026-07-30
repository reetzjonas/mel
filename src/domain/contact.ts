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
  note: string
  /** For kind=group: member uids. */
  memberUids: string[]
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
