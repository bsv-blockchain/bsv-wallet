/**
 * XR-073 (SEC2-057, SEC2-076): the host-class check shared by the handle
 * registry resolver, TrustScreen's manifest import, and the trust-icon
 * prefetch. This is a floor, not a firewall — no DNS resolution happens here,
 * so a hostname that only *resolves* to a private address is not caught. What
 * this closes is a destination that names one directly.
 */
import { isPrivateNetworkHost, isPublicHttpsUrl } from '../../core/net/publicDestination'

describe('isPublicHttpsUrl', () => {
  it('accepts an ordinary public https URL', () => {
    expect(isPublicHttpsUrl('https://example.com/manifest.json')).toBe(true)
    expect(isPublicHttpsUrl('https://sub.example.com:8443/api/{query}')).toBe(true)
  })

  it('rejects http, and every non-https scheme', () => {
    expect(isPublicHttpsUrl('http://example.com')).toBe(false)
    expect(isPublicHttpsUrl('ftp://example.com')).toBe(false)
    expect(isPublicHttpsUrl('not a url at all')).toBe(false)
  })

  it('rejects credentials embedded in the URL', () => {
    expect(isPublicHttpsUrl('https://user:pass@example.com')).toBe(false)
  })

  it('rejects loopback', () => {
    expect(isPublicHttpsUrl('https://127.0.0.1/x')).toBe(false)
    expect(isPublicHttpsUrl('https://127.55.0.9:4873/x')).toBe(false)
    expect(isPublicHttpsUrl('https://localhost/x')).toBe(false)
    expect(isPublicHttpsUrl('https://foo.localhost/x')).toBe(false)
    expect(isPublicHttpsUrl('https://[::1]/x')).toBe(false)
  })

  it('rejects RFC1918 private ranges', () => {
    expect(isPublicHttpsUrl('https://10.1.2.3/x')).toBe(false)
    expect(isPublicHttpsUrl('https://172.16.0.5/x')).toBe(false)
    expect(isPublicHttpsUrl('https://172.31.255.255/x')).toBe(false)
    expect(isPublicHttpsUrl('https://192.168.1.1/x')).toBe(false)
    // 172.32.x.x is OUTSIDE the RFC1918 range and must not be rejected.
    expect(isPublicHttpsUrl('https://172.32.0.5/x')).toBe(true)
  })

  it('rejects link-local, CGNAT, and .local', () => {
    expect(isPublicHttpsUrl('https://169.254.1.1/x')).toBe(false)
    expect(isPublicHttpsUrl('https://100.64.0.1/x')).toBe(false)
    expect(isPublicHttpsUrl('https://printer.local/x')).toBe(false)
    expect(isPublicHttpsUrl('https://[fe80::1]/x')).toBe(false)
    expect(isPublicHttpsUrl('https://[fc00::1]/x')).toBe(false)
  })

  it('rejects an IPv4-mapped IPv6 literal that embeds a private address', () => {
    expect(isPublicHttpsUrl('https://[::ffff:127.0.0.1]/x')).toBe(false)
  })
})

/**
 * XR-024 (SEC2-055): the address-class half of isPublicHttpsUrl, exposed for
 * validators (parseExternalOrigin's https origin, validateRelayUrl's wss
 * origin) that enforce a different scheme themselves.
 */
describe('isPrivateNetworkHost', () => {
  it('accepts an ordinary public hostname', () => {
    expect(isPrivateNetworkHost('example.com')).toBe(false)
  })

  it('rejects loopback, RFC1918, link-local, and reserved-TLD literals', () => {
    expect(isPrivateNetworkHost('127.0.0.1')).toBe(true)
    expect(isPrivateNetworkHost('10.1.2.3')).toBe(true)
    expect(isPrivateNetworkHost('192.168.1.1')).toBe(true)
    expect(isPrivateNetworkHost('169.254.1.1')).toBe(true)
    expect(isPrivateNetworkHost('localhost')).toBe(true)
    expect(isPrivateNetworkHost('printer.local')).toBe(true)
    expect(isPrivateNetworkHost('host.internal')).toBe(true)
    expect(isPrivateNetworkHost('[::1]')).toBe(true)
  })

  it('rejects the empty hostname', () => {
    expect(isPrivateNetworkHost('')).toBe(true)
  })
})
