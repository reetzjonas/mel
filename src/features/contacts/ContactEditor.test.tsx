import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keyFromText } from '../../domain/contactKey'
import type { Contact } from '../../domain/contact'
import { ContactEditor } from './ContactEditor'

afterEach(cleanup)

const contact = (over: Partial<Contact> = {}): Contact => ({
  id: 'c1',
  addressBookIds: { a: true },
  kind: 'individual',
  fullName: '',
  given: '',
  surname: '',
  nickname: '',
  organization: '',
  jobTitle: '',
  emails: [{ value: '', label: null }],
  phones: [{ value: '', label: null }],
  addresses: [],
  urls: [{ value: '', label: null }],
  onlineServices: [],
  keywords: [],
  cryptoKeys: [],
  photo: '',
  birthday: '',
  note: '',
  memberUids: [],
  ...over,
})

function editor(over: Partial<Contact> = {}) {
  return render(<ContactEditor initial={contact(over)} onSave={vi.fn()} onCancel={vi.fn()} />)
}

describe('what keyboard each field asks for', () => {
  it('asks for a phone keypad on the phone field', () => {
    editor()
    expect(document.querySelector('input[type="tel"]')).not.toBeNull()
  })

  it('keeps the email field a real email field', () => {
    editor()
    expect(document.querySelector('input[type="email"]')).not.toBeNull()
  })

  /*
   * A website typed as "example.com" is what people actually write, and
   * type="url" would reject it on submit — so the URL field buys the keyboard
   * with inputMode and leaves validation alone.
   */
  it('gets the URL keyboard without demanding a scheme', () => {
    editor()
    const url = document.querySelector('input[inputmode="url"]')
    expect(url).not.toBeNull()
    expect(url?.getAttribute('type')).toBe('text')
  })
})

describe('what the browser is told to autofill', () => {
  /*
   * The whole form is about another person. A standard token here invites the
   * browser to offer the signed-in user's own name, phone and address, and one
   * stray tap then files the user's own details under somebody else's name.
   */
  it('offers the user their own profile in no field at all', () => {
    const { container } = editor({ addresses: [{ full: '', label: null }] })
    // File inputs are exempt: there is nothing for a profile to autofill there.
    const fields = [...container.querySelectorAll('input:not([type="file"]), textarea')]
    expect(fields.length).toBeGreaterThan(5)
    for (const field of fields) expect(field.getAttribute('autocomplete')).toBe('off')
  })

  it('carries no name attribute for autofill heuristics to match on', () => {
    const { container } = editor()
    for (const field of container.querySelectorAll('input, textarea'))
      expect(field.getAttribute('name')).toBeNull()
  })

  it('covers the fields added by the + button too', () => {
    editor({
      phones: [
        { value: '', label: null },
        { value: '', label: null },
      ],
    })
    const phones = [...document.querySelectorAll('input[type="tel"]')]
    expect(phones).toHaveLength(2)
    for (const phone of phones) expect(phone.getAttribute('autocomplete')).toBe('off')
  })
})

describe('the form still edits what it was given', () => {
  it('shows the values it was opened with', () => {
    editor({ given: 'Erika', surname: 'Mustermann' })
    expect(screen.getByDisplayValue('Erika')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Mustermann')).toBeInTheDocument()
  })
})

describe('adding a public key', () => {
  const PGP =
    '-----BEGIN PGP PUBLIC KEY BLOCK-----\nmDMEZfake\n-----END PGP PUBLIC KEY BLOCK-----\n'

  function paste(text: string) {
    const onSave = vi.fn()
    render(<ContactEditor initial={contact()} onSave={onSave} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add: Public keys' }))
    fireEvent.change(screen.getByLabelText('Paste the key'), { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }))
    return onSave
  }

  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  it('keeps a pasted key and saves it with the card', () => {
    const onSave = paste(`here you go\n\n${PGP}`)
    expect(screen.getByText('PGP public key')).toBeInTheDocument()
    save()
    expect(onSave.mock.calls[0]?.[0].cryptoKeys).toEqual([keyFromText(PGP)])
  })

  /*
   * A field labelled "public key" holding a stray paragraph is worse than an
   * empty one: everything downstream would treat it as a key and fail later,
   * somewhere the user cannot connect back to this moment.
   */
  it('refuses text that is not a key, and says so', () => {
    const onSave = paste('my key is on my website somewhere')
    expect(screen.getByText(/not a public key/)).toBeInTheDocument()
    expect(screen.queryByText('PGP public key')).not.toBeInTheDocument()
    save()
    expect(onSave.mock.calls[0]?.[0].cryptoKeys).toEqual([])
  })

  it('removes a key again', () => {
    const onSave = vi.fn()
    render(
      <ContactEditor
        initial={contact({ cryptoKeys: [keyFromText(PGP)!] })}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove key: PGP public key' }))
    expect(screen.queryByText('PGP public key')).not.toBeInTheDocument()
    save()
    expect(onSave.mock.calls[0]?.[0].cryptoKeys).toEqual([])
  })
})
