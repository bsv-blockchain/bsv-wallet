import { Validation } from '@bsv/sdk'
import { ADMIN_ORIGINATOR } from '../../core/config'
import { parseExternalOrigin } from '../../core/services/externalOrigin'

describe('parseExternalOrigin', () => {
  it('canonicalizes a bare HTTPS origin and preserves a non-default port', () => {
    expect(parseExternalOrigin('https://Example.COM:8443/')).toEqual({
      origin: 'https://example.com:8443',
      originator: 'example.com:8443'
    })
  })

  it.each([
    'http://example.com',
    'example.com',
    'https://user:password@example.com',
    'https://example.com/path',
    'https://example.com/?query=1',
    'https://example.com/#fragment',
    ADMIN_ORIGINATOR,
    `https://${ADMIN_ORIGINATOR}`,
    `https://${ADMIN_ORIGINATOR.toUpperCase()}:8443`,
    'https://anything.invalid'
  ])('rejects an origin outside the external trust boundary: %s', raw => {
    expect(() => parseExternalOrigin(raw)).toThrow()
  })

  /**
   * XR-024 (SEC2-055): pairing relies on TLS for control of the advertised
   * origin, but nothing stopped that origin from naming a loopback/private/
   * link-local literal directly -- a self-signed pairing payload could make
   * the device issue a real fetch into its own local network.
   */
  it.each([
    'https://127.0.0.1/',
    'https://127.55.0.9:4873/',
    'https://192.168.1.5/',
    'https://10.0.0.5/',
    'https://172.16.0.1/',
    'https://169.254.1.1/',
    'https://localhost/',
    'https://foo.localhost/',
    'https://printer.local/',
    'https://host.internal/',
    'https://[::1]/'
  ])('rejects a pairing origin naming a private-network destination: %s', raw => {
    expect(() => parseExternalOrigin(raw)).toThrow()
  })

  it('still accepts an ordinary public https origin outside RFC1918 (172.32.x.x)', () => {
    expect(parseExternalOrigin('https://172.32.0.5/')).toEqual({
      origin: 'https://172.32.0.5',
      originator: '172.32.0.5'
    })
  })

  // @bsv/sdk 2.8 accepts only canonical hostnames as originators, so the
  // internal authority cannot sit outside hostname space any more. It sits in
  // the RFC 6761 `.invalid` TLD instead: never resolvable, so no host can be
  // served from it, and refused outright at the external trust boundary.
  it('keeps the internal authority in reserved, unresolvable hostname space', () => {
    expect(Validation.validateOriginator(ADMIN_ORIGINATOR)).toBe(ADMIN_ORIGINATOR)
    expect(ADMIN_ORIGINATOR.endsWith('.invalid')).toBe(true)
  })
})
