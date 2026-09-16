import { parsePeerPayURI, peerPayValidationMessage, validatePeerPayURI } from '../../core/parsePeerPayURI'

// secp256k1 generator point, lowercase — the form the parser normalises every key to.
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

describe('validatePeerPayURI — key strictness', () => {
  it('rejects an out-of-range x coordinate that PublicKey.fromString would silently reduce', () => {
    // p + 1. The SDK reduces x mod p and hands back the point for x = 1 rather than throwing,
    // so parse success alone would accept a key nobody holds.
    const outOfRange = '02' + 'ff'.repeat(27) + 'fe' + 'fffffc30'
    const r = validatePeerPayURI(`peerpay:${outOfRange}`)
    expect(r.identityKey).toBeUndefined()
    expect(r.errors.identityKey).toBeTruthy()
  })

  it('accepts an uppercase key and lowercases it', () => {
    const r = validatePeerPayURI(`peerpay:${KEY.toUpperCase()}`)
    expect(r.identityKey).toBe(KEY)
    expect(r.errors).toEqual({})
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

  it('drops a url whose authority hides the real host behind userinfo', () => {
    // Readable prefix is the trusted host; the real host is evil.example.
    const spoof = encodeURIComponent('https://mb.trusted.example@evil.example')
    expect(validatePeerPayURI(`peerpay:${KEY}?url=${spoof}`).messageBoxUrl).toBeUndefined()
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

// ── Token requests: `asset=<outpoint>` selects the money, `amount=` is its base units ──
//
// Maintainer decision (2026-09-15): `sats=` is the BSV selector and `amount=`
// de facto names a token, so it needs `asset=` beside it; both are optional,
// and `asset=` alone is an open token request (the payer chooses the figure).
const ASSET = 'ab'.repeat(32) + '.0'

describe('validatePeerPayURI — asset and amount', () => {
  it('reads asset and amount together, base units untouched', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}?asset=${ASSET}&amount=2500`)
    expect(r.asset).toBe(ASSET)
    expect(r.amount).toBe(2500)
    expect(r.sats).toBeUndefined()
    expect(r.errors).toEqual({})
  })

  it('lowercases the asset outpoint the way it lowercases the key', () => {
    expect(validatePeerPayURI(`peerpay:${KEY}?asset=${ASSET.toUpperCase()}`).asset).toBe(ASSET)
  })

  it('reads asset alone as an open token request', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}?asset=${ASSET}`)
    expect(r.asset).toBe(ASSET)
    expect(r.amount).toBeUndefined()
    expect(r.errors).toEqual({})
  })

  it('treats amount=0 as absent, exactly as sats=0', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}?asset=${ASSET}&amount=0`)
    expect(r.amount).toBeUndefined()
    expect(r.errors).toEqual({})
  })

  it('refuses an amount with no asset to denominate it', () => {
    const r = validatePeerPayURI(`peerpay:${KEY}?amount=2500`)
    expect(r.errors.amount).toBeTruthy()
    expect(parsePeerPayURI(`peerpay:${KEY}?amount=2500`)).toBeNull()
  })

  it('refuses sats beside a token request rather than guessing the money', () => {
    expect(validatePeerPayURI(`peerpay:${KEY}?sats=10&asset=${ASSET}`).errors.sats).toBeTruthy()
    expect(validatePeerPayURI(`peerpay:${KEY}?sats=10&amount=5`).errors.sats).toBeTruthy()
    expect(parsePeerPayURI(`peerpay:${KEY}?sats=10&asset=${ASSET}`)).toBeNull()
  })

  it('refuses a malformed asset or amount, never dropping it silently', () => {
    expect(validatePeerPayURI(`peerpay:${KEY}?asset=not-an-outpoint`).errors.asset).toBeTruthy()
    expect(validatePeerPayURI(`peerpay:${KEY}?asset=${'ab'.repeat(32)}`).errors.asset).toBeTruthy()
    expect(validatePeerPayURI(`peerpay:${KEY}?asset=${ASSET}&amount=2.5`).errors.amount).toBeTruthy()
    expect(validatePeerPayURI(`peerpay:${KEY}?asset=${ASSET}&amount=-1`).errors.amount).toBeTruthy()
  })

  it('returns asset and amount from parsePeerPayURI', () => {
    expect(parsePeerPayURI(`peerpay:${KEY}?asset=${ASSET}&amount=7`)).toEqual({
      identityKey: KEY,
      asset: ASSET,
      amount: 7
    })
  })

  it('joins asset and amount errors into the message', () => {
    const msg = peerPayValidationMessage(validatePeerPayURI(`peerpay:${KEY}?asset=bad&amount=x`))
    expect(msg).toMatch(/asset/i)
    expect(msg).toMatch(/amount/i)
  })
})
