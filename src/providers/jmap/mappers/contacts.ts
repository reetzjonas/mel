import type { AddressBook, Contact, LabeledValue } from '../../../domain/contact'

// JSContact (RFC 9553) shapes as served by RFC 9610 ContactCard objects.

interface JsContext {
  contexts?: Record<string, boolean> | null
}

export interface JmapContactCard {
  id: string
  addressBookIds: Record<string, boolean>
  '@type'?: 'Card'
  version?: string
  kind?: string | null
  name?: {
    full?: string | null
    components?: Array<{ kind: string; value: string }> | null
  } | null
  nicknames?: Record<string, { name: string }> | null
  organizations?: Record<string, { name?: string | null }> | null
  titles?: Record<string, { name: string }> | null
  emails?: Record<string, JsContext & { address: string }> | null
  phones?: Record<string, JsContext & { number: string }> | null
  addresses?: Record<
    string,
    JsContext & {
      full?: string | null
      components?: Array<{ kind: string; value: string }> | null
    }
  > | null
  links?: Record<string, JsContext & { uri: string; kind?: string | null }> | null
  onlineServices?: Record<
    string,
    JsContext & { service?: string | null; user?: string | null; uri?: string | null }
  > | null
  keywords?: Record<string, boolean> | null
  notes?: Record<string, { note: string }> | null
  members?: Record<string, boolean> | null
  uid?: string
}

export interface JmapAddressBook {
  id: string
  name: string
  isDefault?: boolean
  myRights?: { mayWrite?: boolean; mayDelete?: boolean }
}

function contextLabel(v: JsContext): string | null {
  const ctx = Object.keys(v.contexts ?? {})[0]
  return ctx ?? null
}

function mapValues<V, O>(
  rec: Record<string, V> | null | undefined,
  map: (v: V) => O | null,
): O[] {
  return Object.values(rec ?? {})
    .map(map)
    .filter((x): x is O => x !== null)
}

function nameComponent(card: JmapContactCard, kind: string): string {
  return card.name?.components?.find((c) => c.kind === kind)?.value ?? ''
}

export function toAddressBook(b: JmapAddressBook): AddressBook {
  return {
    id: b.id,
    name: b.name,
    isDefault: b.isDefault ?? false,
    mayWrite: b.myRights?.mayWrite ?? true,
    mayDelete: b.myRights?.mayDelete ?? true,
  }
}

export function toContact(card: JmapContactCard): Contact {
  const addressBookIds: Record<string, true> = {}
  for (const [id, on] of Object.entries(card.addressBookIds ?? {})) if (on) addressBookIds[id] = true
  const kind =
    card.kind === 'group' || card.kind === 'org' ? card.kind : card.kind === 'individual' ? 'individual' : 'other'
  return {
    id: card.id,
    addressBookIds,
    kind: card.kind == null ? 'individual' : kind,
    fullName: card.name?.full ?? '',
    given: nameComponent(card, 'given'),
    surname: nameComponent(card, 'surname'),
    nickname: Object.values(card.nicknames ?? {})[0]?.name ?? '',
    organization: Object.values(card.organizations ?? {})[0]?.name ?? '',
    jobTitle: Object.values(card.titles ?? {})[0]?.name ?? '',
    emails: mapValues(card.emails, (e) =>
      e.address ? { value: e.address, label: contextLabel(e) } : null,
    ),
    phones: mapValues(card.phones, (p) =>
      p.number ? { value: p.number, label: contextLabel(p) } : null,
    ),
    addresses: mapValues(card.addresses, (a) => {
      const full = a.full ?? a.components?.map((c) => c.value).join(', ') ?? ''
      return full ? { full, label: contextLabel(a) } : null
    }),
    urls: mapValues(card.links, (l) => (l.uri ? { value: l.uri, label: contextLabel(l) } : null)),
    // Kept apart rather than flattened to one string: a card may carry the
    // handle, the URI, or both, and writing back only what was displayed would
    // drop the other half.
    onlineServices: mapValues(card.onlineServices, (o) => {
      const user = o.user ?? ''
      const uri = o.uri ?? ''
      return user || uri ? { service: o.service ?? '', user, uri } : null
    }),
    keywords: Object.entries(card.keywords ?? {})
      .filter(([, on]) => on)
      .map(([k]) => k),
    note: Object.values(card.notes ?? {})[0]?.note ?? '',
    memberUids: Object.entries(card.members ?? {})
      .filter(([, on]) => on)
      .map(([uid]) => uid),
  }
}

/*
 * Empty comes back as null, never as an omitted key.
 *
 * ContactCard/set takes an update as a patch, so a property mel leaves out is
 * one the server keeps: emitting undefined here meant deleting a contact's last
 * email in the editor saved cleanly and changed nothing at all. null is how
 * JSContact says "no value", and it is the only thing that clears.
 */
function labeled(list: LabeledValue[], build: (v: LabeledValue) => Record<string, unknown>) {
  const out: Record<string, Record<string, unknown>> = {}
  list.forEach((v, i) => {
    const obj = build(v)
    if (v.label) obj['contexts'] = { [v.label]: true }
    out[`k${i}`] = obj
  })
  return Object.keys(out).length ? out : null
}

function onlineServiceList(services: Contact['onlineServices']) {
  const usable = services.filter((o) => o.user || o.uri)
  if (!usable.length) return null
  return Object.fromEntries(
    usable.map((o, i) => [
      `s${i}`,
      {
        '@type': 'OnlineService',
        ...(o.service ? { service: o.service } : {}),
        ...(o.user ? { user: o.user } : {}),
        uri: o.uri || o.user,
      },
    ]),
  )
}

/** Build the flat JSContact card for ContactCard/set create/update. */
export function fromContact(c: Contact): Record<string, unknown> {
  const components: Array<{ kind: string; value: string }> = []
  if (c.given) components.push({ kind: 'given', value: c.given })
  if (c.surname) components.push({ kind: 'surname', value: c.surname })
  return {
    '@type': 'Card',
    version: '1.0',
    kind: c.kind === 'other' ? undefined : c.kind,
    addressBookIds: c.addressBookIds,
    name: components.length
      ? { components, isOrdered: true }
      : c.fullName
        ? { full: c.fullName }
        : null,
    nicknames: c.nickname ? { n0: { name: c.nickname } } : null,
    organizations: c.organization ? { o0: { name: c.organization } } : null,
    titles: c.jobTitle ? { t0: { name: c.jobTitle } } : null,
    emails: labeled(c.emails, (v) => ({ address: v.value })),
    phones: labeled(c.phones, (v) => ({ number: v.value })),
    addresses: c.addresses.length
      ? Object.fromEntries(
          c.addresses.map((a, i) => [
            `a${i}`,
            { full: a.full, ...(a.label ? { contexts: { [a.label]: true } } : {}) },
          ]),
        )
      : null,
    links: labeled(c.urls, (v) => ({ uri: v.value })),
    /*
     * Both `@type` and `uri` are load-bearing: Stalwart drops an entry missing
     * either one *silently* — the card is created, reports no error, and simply
     * comes back without it. So the handle stands in as the uri when the card
     * carries no link; the server stores any string there, and reading puts the
     * handle back where it belongs.
     */
    onlineServices: onlineServiceList(c.onlineServices),
    keywords: c.keywords.length ? Object.fromEntries(c.keywords.map((k) => [k, true])) : null,
    notes: c.note ? { note0: { note: c.note } } : null,
  }
}
