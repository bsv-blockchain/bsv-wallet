import {
  inferRail,
  classifyScan,
  classifyRecipientInput,
  isValidBsvAddress,
  isCompressedPublicKey,
  normalizeAddressInput,
  legacyRedirectTarget,
  PRECONDITION_KEYS,
  CONSEQUENCE_KEYS
} from '../../core/pay/rails'
import { encodeSession, mintSession } from '../../core/localpay/session'

// secp256k1 generator point — a genuinely valid compressed pubkey.
//
// Lowercase is load-bearing, not cosmetic: parsePeerPayURI's
// COMPRESSED_PUBLIC_KEY_REGEX is /^0[23][0-9a-f]{64}$/ with no `i` flag, so a
// `peerpay:` URI carrying uppercase hex is rejected as malformed. This constant
// therefore has to be in the form a real peerpay link uses.
const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
// A real mainnet P2PKH address (base58check).
const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'

const session = () =>
  mintSession({
    identityKey: KEY,
    derivationPrefix: 'ZGV2LXByZWZpeA==',
    derivationSuffix: 'ZGV2LXN1ZmZpeA==',
    supportsAwdl: false
  })

describe('inferRail', () => {
  it('maps a scanned nearby session to the nearby rail', () => {
    expect(inferRail({ kind: 'nearby', session: session() })).toBe('nearby')
  })

  it('maps a resolved identity to the handle rail', () => {
    expect(inferRail({ kind: 'handle', identityKey: KEY })).toBe('handle')
  })

  it('maps a validated address to the address rail', () => {
    expect(inferRail({ kind: 'address', address: ADDRESS })).toBe('address')
  })
})

describe('classifyScan', () => {
  it('reads a peerpay URI as a handle target, carrying the amount', () => {
    const target = classifyScan(`peerpay:${KEY}?sats=5000`)
    expect(target).toEqual({ kind: 'handle', identityKey: KEY, sats: 5000 })
  })

  it('rejects a peerpay URI whose identity key is malformed', () => {
    expect(classifyScan('peerpay:not-a-key')).toBeNull()
  })

  it('reads a bare compressed public key as a handle target', () => {
    expect(classifyScan(KEY)).toEqual({ kind: 'handle', identityKey: KEY })
  })

  it('reads an encoded localpay session as a nearby target', () => {
    const target = classifyScan(encodeSession(session()))
    expect(target?.kind).toBe('nearby')
  })

  it('reads a bare base58 address as an address target', () => {
    expect(classifyScan(ADDRESS)).toEqual({ kind: 'address', address: ADDRESS })
  })

  it('strips a bitcoin: scheme and its query before classifying', () => {
    expect(classifyScan(`bitcoin:${ADDRESS}?amount=0.1`)).toEqual({ kind: 'address', address: ADDRESS })
  })

  it('returns null for junk rather than guessing a rail', () => {
    expect(classifyScan('hello world')).toBeNull()
  })

  it('tolerates surrounding whitespace', () => {
    expect(classifyScan(`  ${ADDRESS}  `)).toEqual({ kind: 'address', address: ADDRESS })
  })
})

describe('address validation', () => {
  it('accepts a base58check address', () => {
    expect(isValidBsvAddress(ADDRESS)).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(isValidBsvAddress('')).toBe(false)
  })

  it('rejects a checksum-broken address', () => {
    expect(isValidBsvAddress(`${ADDRESS.slice(0, -1)}X`)).toBe(false)
  })

  it('normalizes a bitcoin: URI to a bare address', () => {
    expect(normalizeAddressInput(`bitcoin:${ADDRESS}?label=x`)).toBe(ADDRESS)
  })
})

describe('copy keys', () => {
  it('names a precondition and a consequence for every rail', () => {
    for (const rail of ['nearby', 'handle', 'address'] as const) {
      expect(PRECONDITION_KEYS[rail]).toMatch(/^pay_pre_/)
      expect(CONSEQUENCE_KEYS[rail]).toMatch(/^pay_conseq_/)
    }
  })
})

describe('legacyRedirectTarget', () => {
  it('sends /payments to the pay-handle cell', () => {
    expect(legacyRedirectTarget('payments', {})).toEqual({ pathname: '/pay', params: { cell: 'pay-handle' } })
  })

  it('forwards a peerpay URI so the deep link still lands on the recipient', () => {
    const uri = `peerpay:${KEY}?sats=1000`
    expect(legacyRedirectTarget('payments', { peerpay: uri })).toEqual({
      pathname: '/pay',
      params: { cell: 'pay-handle', peerpay: uri }
    })
  })

  it('forwards identityKey and sats params', () => {
    expect(legacyRedirectTarget('payments', { identityKey: KEY, sats: '42' })).toEqual({
      pathname: '/pay',
      params: { cell: 'pay-handle', identityKey: KEY, sats: '42' }
    })
  })

  it('sends /legacy-payments to the get-address cell', () => {
    expect(legacyRedirectTarget('legacy-payments', {})).toEqual({
      pathname: '/pay',
      params: { cell: 'get-address' }
    })
  })

  it('sends /local-payments to the get-nearby cell', () => {
    expect(legacyRedirectTarget('local-payments', {})).toEqual({
      pathname: '/pay',
      params: { cell: 'get-nearby' }
    })
  })

  it('drops undefined params rather than forwarding them', () => {
    expect(legacyRedirectTarget('payments', { sats: undefined }).params).toEqual({ cell: 'pay-handle' })
  })
})

describe('classifyRecipientInput', () => {
  // Uppercase form of KEY: valid on the curve, but not the lowercase BRC-125 wants.
  const KEY_UPPER = KEY.toUpperCase()
  // Same length and alphabet as ADDRESS with the last character changed: checksum fails.
  const BROKEN_ADDRESS = ADDRESS.slice(0, -1) + (ADDRESS.endsWith('2') ? '3' : '2')

  it('treats an empty or whitespace string as empty', () => {
    expect(classifyRecipientInput('')).toEqual({ kind: 'empty' })
    expect(classifyRecipientInput('   ')).toEqual({ kind: 'empty' })
  })

  it('reads a base58check address as an address target', () => {
    expect(classifyRecipientInput(ADDRESS)).toEqual({ kind: 'address', address: ADDRESS })
    expect(classifyRecipientInput(`  ${ADDRESS}  `)).toEqual({ kind: 'address', address: ADDRESS })
  })

  it('flags an address-shaped string whose checksum fails, and does not search for it', () => {
    expect(classifyRecipientInput(BROKEN_ADDRESS)).toEqual({ kind: 'invalid_address' })
  })

  it('strips a bitcoin: scheme and query before the address rule', () => {
    expect(classifyRecipientInput(`bitcoin:${ADDRESS}?amount=0.1`)).toEqual({ kind: 'address', address: ADDRESS })
    expect(classifyRecipientInput(`bitcoin:${BROKEN_ADDRESS}`)).toEqual({ kind: 'invalid_address' })
  })

  it('reads a compressed key as a handle, lowercased', () => {
    expect(classifyRecipientInput(KEY)).toEqual({ kind: 'handle', identityKey: KEY })
    expect(classifyRecipientInput(KEY_UPPER)).toEqual({ kind: 'handle', identityKey: KEY })
  })

  it('sends an uncompressed key to search rather than paying it', () => {
    // 04 + 128 hex: the right length for an uncompressed key, not a compressed one.
    const uncompressed = '04' + 'ab'.repeat(64)
    expect(classifyRecipientInput(uncompressed)).toEqual({ kind: 'search', query: uncompressed })
  })

  it('reads a peerpay link as a handle carrying sats and messageBoxUrl', () => {
    const uri = `peerpay:${KEY}?sats=250&url=${encodeURIComponent('https://mb.example')}`
    expect(classifyRecipientInput(uri)).toEqual({
      kind: 'handle',
      identityKey: KEY,
      sats: 250,
      messageBoxUrl: 'https://mb.example'
    })
  })

  it('reports a malformed peerpay link as invalid_link with the validator message', () => {
    const r = classifyRecipientInput('peerpay:nope')
    expect(r.kind).toBe('invalid_link')
    expect((r as { message: string }).message).toContain('identity key')
  })

  it('reports a peerpay link with a good key but a bad amount as invalid_link', () => {
    const r = classifyRecipientInput(`peerpay:${KEY}?sats=2.5`)
    expect(r.kind).toBe('invalid_link')
    expect((r as { message: string }).message).toContain('sats')
  })

  it('sends a phone-shaped number to search — it is too short to be an address', () => {
    expect(classifyRecipientInput('12125551234')).toEqual({ kind: 'search', query: '12125551234' })
  })

  it('sends an email or a handle to search', () => {
    expect(classifyRecipientInput('alice@example.com')).toEqual({ kind: 'search', query: 'alice@example.com' })
    expect(classifyRecipientInput('alice')).toEqual({ kind: 'search', query: 'alice' })
  })
})

describe('classifyScan — key strictness and url', () => {
  it('rejects an uncompressed bare key', () => {
    expect(classifyScan('04' + 'ab'.repeat(64))).toBeNull()
  })

  it('lowercases a scanned compressed key', () => {
    expect(classifyScan(KEY.toUpperCase())).toEqual({ kind: 'handle', identityKey: KEY })
  })

  it('carries messageBoxUrl from a peerpay link', () => {
    const target = classifyScan(`peerpay:${KEY}?sats=5&url=${encodeURIComponent('https://mb.example')}`)
    expect(target).toEqual({ kind: 'handle', identityKey: KEY, sats: 5, messageBoxUrl: 'https://mb.example' })
  })
})

describe('isCompressedPublicKey', () => {
  it('accepts 02/03 + 64 hex on the curve, either case', () => {
    expect(isCompressedPublicKey(KEY)).toBe(true)
    expect(isCompressedPublicKey(KEY.toUpperCase())).toBe(true)
  })
  it('rejects the wrong prefix, length or a point off the curve', () => {
    expect(isCompressedPublicKey('04' + 'ab'.repeat(64))).toBe(false)
    expect(isCompressedPublicKey(KEY.slice(0, 64))).toBe(false)
    expect(isCompressedPublicKey('02' + 'ff'.repeat(32))).toBe(false)
  })
})
