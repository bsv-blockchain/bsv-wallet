import { parsePeerPayURI, peerPayValidationMessage, validatePeerPayURI } from '../../core/parsePeerPayURI'

// secp256k1 generator point, lowercase — the only form the key regex accepts.
const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe('validatePeerPayURI — scheme', () => {
  it('accepts the spec form peerpay:<key>', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}`)
    expect(r.isPeerPay).toBe(true)
    expect(r.identityKey).toBe(KEY)
    expect(r.errors).toEqual({})
  })

  it('tolerates peerpay://<key> and reads the same key', () => {
    const r = validatePeerPayURI(`peerpay://${KEY}?sats=12`)
    expect(r.identityKey).toBe(KEY)
    expect(r.sats).toBe(12)
    expect(r.errors).toEqual({})
  })

  it('ignores surrounding whitespace', () => {
    expect(validatePeerPayURI(`  peerpay:${KEY}  `).identityKey).toBe(KEY)
  })
})

describe('validatePeerPayURI — url extension', () => {
  it('reads a percent-encoded https url alongside sats', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}?sats=5000&url=${encodeURIComponent('https://mb.example')}`)
    expect(r.sats).toBe(5000)
    expect(r.messageBoxUrl).toBe('https://mb.example')
    expect(r.errors).toEqual({})
  })

  it('trims trailing slashes off the url', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}?url=${encodeURIComponent('https://mb.example/')}`)
    expect(r.messageBoxUrl).toBe('https://mb.example')
  })

  it('keeps a path on the url', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}?url=${encodeURIComponent('https://mb.example/box/v1')}`)
    expect(r.messageBoxUrl).toBe('https://mb.example/box/v1')
  })

  it('drops an http url rather than failing the link', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}?url=${encodeURIComponent('http://mb.example')}`)
    expect(r.messageBoxUrl).toBeUndefined()
    expect(r.identityKey).toBe(KEY)
    expect(r.errors).toEqual({})
  })

  it('drops a bare host, an empty url and garbage', () => {
    expect(validatePeerPayURI(`peerpay:${KEY}?url=mb.example`).messageBoxUrl).toBeUndefined()
    expect(validatePeerPayURI(`peerpay:${KEY}?url=`).messageBoxUrl).toBeUndefined()
    expect(validatePeerPayURI(`peerpay:${KEY}?url=${encodeURIComponent('https://a b')}`).messageBoxUrl).toBeUndefined()
  })

  it('still rejects a malformed key even when the url is fine', () => {
    const r = validatePeerPayURI(`peerpay:not-a-key?url=${encodeURIComponent('https://mb.example')}`)
    expect(r.identityKey).toBeUndefined()
    expect(r.errors.identityKey).toBeTruthy()
  })
})

describe('parsePeerPayURI', () => {
  it('returns key, sats and messageBoxUrl together', () => {
    expect(parsePeerPayURI(`peerpay:${KEY}?sats=7&url=${encodeURIComponent('https://mb.example')}`)).toEqual({
      identityKey: KEY,
      sats: 7,
      messageBoxUrl: 'https://mb.example'
    })
  })

  it('returns null for a bad key', () => {
    expect(parsePeerPayURI('peerpay:zzz')).toBeNull()
  })
})

describe('peerPayValidationMessage', () => {
  it('is null for a non-peerpay result or a clean one', () => {
    expect(peerPayValidationMessage(null)).toBeNull()
    expect(peerPayValidationMessage(validatePeerPayURI('bitcoin:x'))).toBeNull()
    expect(peerPayValidationMessage(validatePeerPayURI(`peerpay:${KEY}`))).toBeNull()
  })

  it('joins the key and sats errors', () => {
    const msg = peerPayValidationMessage(validatePeerPayURI('peerpay:zzz?sats=-1'))
    expect(msg).toContain('identity key')
    expect(msg).toContain('sats')
  })
})
