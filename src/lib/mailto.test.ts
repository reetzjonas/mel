import { describe, expect, it } from 'vitest'
import { parseMailto, textToHtml } from './mailto'

describe('parseMailto', () => {
  it('reads the plain form a web page writes', () => {
    expect(parseMailto('mailto:erika@example.com')).toEqual({
      to: ['erika@example.com'],
      cc: [],
      bcc: [],
      subject: '',
      body: '',
    })
  })

  it('reads the fields behind the question mark', () => {
    const fields = parseMailto(
      'mailto:a@example.com?cc=b@example.com&bcc=c@example.com&subject=Rechnung%20M%C3%A4rz&body=Hallo%0AGruss',
    )

    expect(fields).toEqual({
      to: ['a@example.com'],
      cc: ['b@example.com'],
      bcc: ['c@example.com'],
      subject: 'Rechnung März',
      body: 'Hallo\nGruss',
    })
  })

  it('keeps a plus in an address instead of turning it into a space', () => {
    /*
     * The whole reason this is hand-rolled rather than URLSearchParams: that
     * applies form-encoding rules, where `+` is a space. A plus-addressed
     * recipient would arrive as "erika news@example.com" and never send.
     */
    expect(parseMailto('mailto:?to=erika+news@example.com')!.to).toEqual(['erika+news@example.com'])
  })

  it('adds up recipients given in both places, as RFC 6068 allows', () => {
    const fields = parseMailto('mailto:a@example.com,b@example.com?to=c@example.com')

    expect(fields!.to).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])
  })

  it('leaves a percent-encoded comma inside the address it belongs to', () => {
    // Splitting after decoding would tear one address into two, and the send
    // would then fail on a fragment nobody typed.
    expect(parseMailto('mailto:%22Lovelace%2C%20Ada%22@example.com')!.to).toEqual([
      '"Lovelace, Ada"@example.com',
    ])
  })

  it('survives a malformed escape rather than losing the whole link', () => {
    const fields = parseMailto('mailto:a@example.com?subject=100%&body=ok')

    expect(fields!.subject).toBe('100%')
    expect(fields!.body).toBe('ok')
  })

  it('says no to anything that is not a mailto link', () => {
    // The handler URL is filled in by the OS; a share target lands on the same
    // route with entirely different parameters.
    expect(parseMailto('https://example.com')).toBeNull()
    expect(parseMailto('')).toBeNull()
  })
})

describe('textToHtml', () => {
  it('keeps the line breaks a shared blurb arrives with', () => {
    expect(textToHtml('one\ntwo')).toBe('<p>one</p><p>two</p>')
  })

  it('keeps a blank line as a blank line', () => {
    expect(textToHtml('one\n\ntwo')).toBe('<p>one</p><p><br></p><p>two</p>')
  })

  it('escapes what would otherwise become markup', () => {
    expect(textToHtml('<b>&')).toBe('<p>&lt;b&gt;&amp;</p>')
  })

  it('is empty for empty text, so the editor opens on a blank line', () => {
    expect(textToHtml('')).toBe('')
  })
})
