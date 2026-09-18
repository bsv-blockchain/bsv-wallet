import { contactAddLinkFor, parseIdentityKeyFromScan } from '../../core/identity/contactLink'

const KEY = '02' + 'ab'.repeat(32)

describe('contactAddLinkFor', () => {
  it('builds the wallet-scheme deep link, lower-cased', () => {
    expect(contactAddLinkFor(KEY.toUpperCase())).toBe(`bsv-wallet://contact/add?identityKey=${KEY}`)
  })
})

describe('parseIdentityKeyFromScan', () => {
  it('reads the key out of a contact-add deep link', () => {
    expect(parseIdentityKeyFromScan(`bsv-wallet://contact/add?identityKey=${KEY}`)).toBe(KEY)
  })

  it('reads the key out of a bsv-browser link too', () => {
    expect(parseIdentityKeyFromScan(`bsv-browser://contact/add?identityKey=${KEY}`)).toBe(KEY)
  })

  it('accepts a bare compressed key', () => {
    expect(parseIdentityKeyFromScan(KEY)).toBe(KEY)
  })

  it('lower-cases an upper-case key', () => {
    expect(parseIdentityKeyFromScan(KEY.toUpperCase())).toBe(KEY)
  })

  it('returns undefined for unrelated text', () => {
    expect(parseIdentityKeyFromScan('peerpay:' + KEY)).toBeUndefined()
    expect(parseIdentityKeyFromScan('not a code')).toBeUndefined()
    expect(parseIdentityKeyFromScan('')).toBeUndefined()
  })

  it('returns undefined for a link missing identityKey', () => {
    expect(parseIdentityKeyFromScan('bsv-wallet://contact/add?foo=bar')).toBeUndefined()
  })
})
