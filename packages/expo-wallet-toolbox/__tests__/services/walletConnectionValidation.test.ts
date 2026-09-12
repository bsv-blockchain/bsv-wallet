import {
  MAX_PAIRING_EXPIRY_HORIZON_SECONDS,
  MAX_RELAY_RESPONSE_BYTES,
  MAX_RPC_CIPHERTEXT_CHARS,
  MAX_RPC_PLAINTEXT_BYTES,
  MAX_RPC_WIRE_CHARS,
  PAIRING_SIGNATURE_DOMAIN,
  buildPairingSignatureMessage,
  buildRelayWebSocketUrl,
  parseBoundedWireEnvelope,
  parseRelayResponse,
  parseWalletProtocol,
  requireBoundedPlaintext,
  validateBackendIdentityKey,
  validateConnectParams,
  validateRelayUrl,
  validateStoredConnectionSequence,
  validateStoredConnectionFields
} from '../../core/services/walletConnectionValidation'

const NOW = 1_800_000_000_000
const VALID_KEY = '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const VALID_PROTOCOL = '[0,"mobile wallet session"]'
const validParams = () => ({
  topic: '123e4567-e89b-12d3-a456-426614174000',
  backendIdentityKey: VALID_KEY,
  protocolID: VALID_PROTOCOL,
  origin: 'https://app.example',
  expiry: String(Math.floor(NOW / 1000) + 120),
  sig: 'A'.repeat(94)
})

describe('wallet connection parameter boundary', () => {
  it('accepts canonical, bounded pairing parameters', () => {
    expect(validateConnectParams(validParams(), NOW)).toMatchObject({
      params: validParams(),
      external: { origin: 'https://app.example', originator: 'app.example' },
      protocolID: [0, 'mobile wallet session']
    })
  })

  it('binds the canonical transport protocol into a versioned QR signature transcript', () => {
    const params = validParams()
    expect(buildPairingSignatureMessage(params)).toBe(
      `${PAIRING_SIGNATURE_DOMAIN}|${params.topic}|${params.backendIdentityKey}|${params.protocolID}|${params.origin}|${params.expiry}`
    )
    expect(buildPairingSignatureMessage({ ...params, protocolID: '[1,"mobile wallet session"]' }))
      .not.toBe(buildPairingSignatureMessage(params))
  })

  it.each([
    { expiry: 'NaN' },
    { expiry: '1800000000.5' },
    { expiry: String(Math.floor(NOW / 1000)) },
    { expiry: String(Math.floor(NOW / 1000) + MAX_PAIRING_EXPIRY_HORIZON_SECONDS + 1) },
    { expiry: '99999999999' }
  ])('rejects a non-finite, expired, noncanonical, or overly distant expiry: %p', override => {
    expect(() => validateConnectParams({ ...validParams(), ...override }, NOW)).toThrow()
  })

  it.each([
    { topic: 'contains|delimiter' },
    { topic: 'x'.repeat(129) },
    { backendIdentityKey: `02${'1'.repeat(64)}` }, // compressed shape, but not a curve point
    { backendIdentityKey: VALID_KEY.toUpperCase() },
    { origin: 'https://APP.example' },
    { origin: 'https://app.example/' },
    { origin: 'https://app.example/path' },
    { sig: 'not+base64url' },
    { sig: 'A'.repeat(200) }
  ])('rejects a noncanonical or oversized signed field before crypto/fetch: %p', override => {
    expect(() => validateConnectParams({ ...validParams(), ...override }, NOW)).toThrow()
  })

  it.each([
    '[3,"mobile wallet session"]',
    '[0,"tiny"] ',
    '[0,"UPPER CASE"]',
    '[0,"double  space"]',
    '[0,"ends in protocol"]',
    '[0,"bad & name"]',
    JSON.stringify([0, 'x'.repeat(401)])
  ])('rejects an invalid or noncanonical WalletProtocol: %s', protocolID => {
    expect(() => parseWalletProtocol(protocolID)).toThrow()
  })

  it('applies the same key/topic/protocol/origin validation to imported connection records', () => {
    expect(validateStoredConnectionFields({
      sessionId: validParams().topic,
      backendIdentityKey: VALID_KEY,
      mobileIdentityKey: VALID_KEY,
      protocolID: VALID_PROTOCOL,
      origin: 'https://app.example'
    })).toMatchObject({ topic: validParams().topic, backendIdentityKey: VALID_KEY })
    expect(() => validateStoredConnectionFields({
      sessionId: 'bad|topic',
      backendIdentityKey: VALID_KEY,
      mobileIdentityKey: VALID_KEY,
      protocolID: VALID_PROTOCOL,
      origin: 'https://app.example'
    })).toThrow()
    expect(() => validateStoredConnectionFields({
      sessionId: validParams().topic,
      backendIdentityKey: VALID_KEY,
      mobileIdentityKey: `02${'1'.repeat(64)}`,
      protocolID: VALID_PROTOCOL,
      origin: 'https://app.example'
    })).toThrow(/mobile identity key/i)
  })

  it('validates the compressed key as a real secp256k1 point', () => {
    expect(validateBackendIdentityKey(VALID_KEY)).toBe(VALID_KEY)
    expect(() => validateBackendIdentityKey(`02${'1'.repeat(64)}`)).toThrow(/point/i)
  })

  it('accepts only canonical stored sequence values that remain safely incrementable', () => {
    expect(validateStoredConnectionSequence(null)).toBe(0)
    expect(validateStoredConnectionSequence('0')).toBe(0)
    expect(validateStoredConnectionSequence('123')).toBe(123)
    for (const value of ['', '01', '1e2', '-1', 'NaN', String(Number.MAX_SAFE_INTEGER)]) {
      expect(() => validateStoredConnectionSequence(value)).toThrow(/sequence/i)
    }
  })
})

describe('relay URL and response boundary', () => {
  it('accepts and canonicalizes only a bare authenticated WSS relay origin', () => {
    expect(validateRelayUrl('wss://Relay.Example:8443/')).toBe('wss://relay.example:8443')
    expect(buildRelayWebSocketUrl('wss://relay.example', validParams().topic)).toBe(
      `wss://relay.example/ws?topic=${validParams().topic}&role=mobile`
    )
  })

  it.each([
    'ws://relay.example',
    'https://relay.example',
    'wss://user:pass@relay.example',
    'wss://relay.example/custom',
    'wss://relay.example?token=x',
    'wss://relay.example/#fragment',
    `wss://${'x'.repeat(2050)}.example`
  ])('rejects an unsafe relay URL: %s', relay => {
    expect(() => validateRelayUrl(relay)).toThrow()
  })

  it('caps and validates the relay discovery JSON before using its URL', () => {
    expect(parseRelayResponse('{"relay":"wss://relay.example/"}')).toBe('wss://relay.example')
    expect(() => parseRelayResponse('{"relay":"ws://relay.example"}')).toThrow()
    expect(() => parseRelayResponse('x'.repeat(MAX_RELAY_RESPONSE_BYTES + 1))).toThrow(/too long|length/i)
  })
})

describe('encrypted RPC transport boundary', () => {
  const topic = validParams().topic

  it('accepts a small canonical envelope for the expected topic', () => {
    expect(parseBoundedWireEnvelope(JSON.stringify({ topic, ciphertext: 'AAAA' }), topic))
      .toEqual({ topic, ciphertext: 'AAAA' })
  })

  it('rejects the wrong topic, unknown fields, and malformed base64url', () => {
    expect(() => parseBoundedWireEnvelope(JSON.stringify({ topic: 'other', ciphertext: 'AAAA' }), topic)).toThrow()
    expect(() => parseBoundedWireEnvelope(JSON.stringify({ topic, ciphertext: 'AAAA', junk: true }), topic)).toThrow()
    expect(() => parseBoundedWireEnvelope(JSON.stringify({ topic, ciphertext: 'A' }), topic)).toThrow()
    expect(() => parseBoundedWireEnvelope(JSON.stringify({ topic, ciphertext: 'AA+A' }), topic)).toThrow()
    expect(() => parseBoundedWireEnvelope(
      JSON.stringify({ topic, ciphertext: 'AAAA', mobileIdentityKey: `02${'1'.repeat(64)}` }), topic
    )).toThrow(/mobile identity key/i)
  })

  it('rejects ciphertext and outer messages at their hard bounds before decode/parse', () => {
    expect(() => parseBoundedWireEnvelope(
      JSON.stringify({ topic, ciphertext: 'A'.repeat(MAX_RPC_CIPHERTEXT_CHARS + 1) }), topic
    )).toThrow(/too large|invalid/i)
    expect(() => parseBoundedWireEnvelope('x'.repeat(MAX_RPC_WIRE_CHARS + 1), topic)).toThrow(/limit/i)
  })

  it('caps decrypted plaintext before TextDecoder and JSON.parse', () => {
    expect(requireBoundedPlaintext([1, 2, 3])).toEqual([1, 2, 3])
    const sparse: number[] = []
    sparse.length = MAX_RPC_PLAINTEXT_BYTES + 1
    expect(() => requireBoundedPlaintext(sparse)).toThrow(/limit/i)
  })
})
