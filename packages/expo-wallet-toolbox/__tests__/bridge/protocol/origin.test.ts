import {
  assertCanonicalOriginator,
  canonicalizeBridgeOrigin,
  hostnameOfUnattested,
  isUnattestedOriginator,
  mintGrantTag,
  OriginRefused,
  unverifiedOriginator
} from '../../../core/bridge/protocol/origin'
import { ADMIN_ORIGINATOR, LEGACY_ADMIN_ORIGINATOR } from '../../../core/config'

const canon = (origin: string, extra: { allowLocalhostHttp?: boolean } = {}) =>
  canonicalizeBridgeOrigin({ origin, attestation: 'browser', ...extra })

describe('canonicalizeBridgeOrigin', () => {
  it('accepts canonical https origins', () => {
    expect(canon('https://example.com')).toMatchObject({
      applicationOrigin: 'https://example.com',
      hostname: 'example.com',
      attestation: 'browser',
      originator: 'example.com'
    })
    expect(canon('https://a-b.example.co.uk:8443')).toMatchObject({
      applicationOrigin: 'https://a-b.example.co.uk:8443',
      hostname: 'a-b.example.co.uk'
    })
    expect(canon('https://xn--bcher-kva.example').hostname).toBe('xn--bcher-kva.example')
  })

  it('keeps the attestation and leaves an unattested originator unminted', () => {
    const r = canonicalizeBridgeOrigin({ origin: 'https://example.com', attestation: 'unattested' })
    expect(r.attestation).toBe('unattested')
    expect(r.originator).toBeUndefined()
  })

  it.each([
    ['http scheme', 'http://example.com'],
    ['no scheme', 'example.com'],
    ['uppercase host', 'https://Example.com'],
    ['uppercase scheme', 'HTTPS://example.com'],
    ['trailing dot', 'https://example.com.'],
    ['IPv4 literal', 'https://127.0.0.1'],
    ['IPv4 literal with port', 'https://10.0.0.1:8443'],
    ['IPv6 literal', 'https://[::1]'],
    ['numeric TLD', 'https://example.123'],
    ['non-ASCII host', 'https://bücher.example'],
    ['default port', 'https://example.com:443'],
    ['zero port', 'https://example.com:0'],
    ['leading-zero port', 'https://example.com:0443'],
    ['port too large', 'https://example.com:65536'],
    ['empty port', 'https://example.com:'],
    ['path', 'https://example.com/'],
    ['path segment', 'https://example.com/a'],
    ['query', 'https://example.com?x=1'],
    ['fragment', 'https://example.com#x'],
    ['userinfo', 'https://user@example.com'],
    ['whitespace', 'https://example.com '],
    ['empty label', 'https://a..example.com'],
    ['leading hyphen label', 'https://-a.example.com'],
    ['trailing hyphen label', 'https://a-.example.com'],
    ['underscore', 'https://a_b.example.com'],
    ['label over 63', `https://${'a'.repeat(64)}.com`],
    ['host over 253', `https://${('a'.repeat(60) + '.').repeat(4)}${'b'.repeat(20)}.com`],
    ['.invalid TLD', 'https://foo.invalid'],
    ['bare invalid', 'https://invalid'],
    ['admin originator', `https://${ADMIN_ORIGINATOR}`],
    ['legacy admin originator', `https://${LEGACY_ADMIN_ORIGINATOR}`],
    ['unverified namespace', 'https://example.com.gabcdefghij.unverified.invalid'],
    ['empty', '']
  ])('refuses %s', (_name, origin) => {
    expect(() => canon(origin)).toThrow(OriginRefused)
  })

  it('refuses origins over 2048 bytes', () => {
    expect(() => canon('https://example.com:8443' + ' '.repeat(2048))).toThrow(OriginRefused)
  })

  it('refuses non-string input', () => {
    expect(() => canon(undefined as unknown as string)).toThrow(OriginRefused)
  })

  it('allows http://localhost:<port> only with allowLocalhostHttp', () => {
    expect(() => canon('http://localhost:3000')).toThrow(OriginRefused)
    expect(canon('http://localhost:3000', { allowLocalhostHttp: true })).toMatchObject({
      applicationOrigin: 'http://localhost:3000',
      hostname: 'localhost',
      originator: 'localhost'
    })
  })

  it.each([
    'http://localhost',
    'http://localhost:',
    'http://localhost:0',
    'http://localhost:03000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'http://localhost.:3000',
    'http://foo.localhost:3000',
    'http://example.com:3000',
    'http://localhost:3000/'
  ])('refuses %s even with allowLocalhostHttp', origin => {
    expect(() => canon(origin, { allowLocalhostHttp: true })).toThrow(OriginRefused)
  })

  it('refuses unattested hostnames that would overflow the originator (over 219 bytes)', () => {
    const label = 'a'.repeat(60)
    const long = `${label}.${label}.${label}.${'b'.repeat(33)}.com`
    expect(long.length).toBeGreaterThan(219)
    expect(() => canonicalizeBridgeOrigin({ origin: `https://${long}`, attestation: 'unattested' })).toThrow(
      OriginRefused
    )
    // The same host is fine when attested: originator is the bare hostname.
    expect(canonicalizeBridgeOrigin({ origin: `https://${long}`, attestation: 'browser' }).hostname).toBe(long)
  })
})

describe('unverified namespace', () => {
  it('round-trips a grant-tag originator', () => {
    const tag = mintGrantTag()
    expect(tag).toMatch(/^g[a-z2-7]{10}$/)
    const o = unverifiedOriginator('example.com', tag)
    expect(o).toBe(`example.com.${tag}.unverified.invalid`)
    expect(isUnattestedOriginator(o)).toBe(true)
    expect(hostnameOfUnattested(o)).toBe('example.com')
    expect(() => assertCanonicalOriginator(o)).not.toThrow()
  })

  it('mints distinct tags', () => {
    expect(new Set(Array.from({ length: 50 }, mintGrantTag)).size).toBe(50)
  })

  it('refuses hostnames over 219 bytes and bad tags', () => {
    const ok = `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(27)}` // 219
    expect(ok.length).toBe(219)
    expect(unverifiedOriginator(ok, 'gabcdefghij').length).toBe(250)
    expect(() => unverifiedOriginator(ok + 'a', 'gabcdefghij')).toThrow(OriginRefused)
    expect(() => unverifiedOriginator('example.com', 'gABCDEFGHIJ')).toThrow(OriginRefused)
    expect(() => unverifiedOriginator('example.com', 'gabcdefghi')).toThrow(OriginRefused)
    expect(() => unverifiedOriginator('example.com', 'xabcdefghij')).toThrow(OriginRefused)
    expect(() => unverifiedOriginator('example.com', 'gabcdefghi1')).toThrow(OriginRefused)
  })

  it('does not treat a tagless namespace name as unattested', () => {
    expect(isUnattestedOriginator('example.com.unverified.invalid')).toBe(false)
    expect(isUnattestedOriginator('example.com')).toBe(false)
    expect(isUnattestedOriginator('gabcdefghij.unverified.invalid')).toBe(false)
    expect(isUnattestedOriginator('example.com.gabcdefghi.unverified.invalid')).toBe(false)
    expect(isUnattestedOriginator('example.com.gabcdefghij1.unverified.invalid')).toBe(false)
    expect(isUnattestedOriginator('Example.com.gabcdefghij.unverified.invalid')).toBe(false)
    expect(isUnattestedOriginator('example.com.gabcdefghij.unverified.invalid.')).toBe(false)
    expect(isUnattestedOriginator('exa mple.gabcdefghij.unverified.invalid')).toBe(false)
    expect(isUnattestedOriginator('a.b.invalid.gabcdefghij.unverified.invalid')).toBe(false)
    expect(isUnattestedOriginator(5 as unknown as string)).toBe(false)
  })

  it('hostnameOfUnattested throws on anything else', () => {
    expect(() => hostnameOfUnattested('example.com')).toThrow(OriginRefused)
  })
})

describe('assertCanonicalOriginator', () => {
  it('accepts plain hostnames', () => {
    expect(() => assertCanonicalOriginator('example.com')).not.toThrow()
    expect(() => assertCanonicalOriginator('localhost')).not.toThrow()
  })

  it.each([
    ADMIN_ORIGINATOR,
    LEGACY_ADMIN_ORIGINATOR,
    'example.com:8443',
    'user@example.com',
    'Example.com',
    'example.com.',
    '',
    'foo.invalid',
    'example.com.unverified.invalid',
    'example.com.gabcdefghij.unverified.invalid.invalid',
    '127.0.0.1',
    'a'.repeat(251)
  ])('refuses %j', o => {
    expect(() => assertCanonicalOriginator(o)).toThrow(OriginRefused)
  })

  it('refuses a non-string', () => {
    expect(() => assertCanonicalOriginator(undefined as unknown as string)).toThrow(OriginRefused)
  })
})
