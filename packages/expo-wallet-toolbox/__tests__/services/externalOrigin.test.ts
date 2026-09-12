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
    ADMIN_ORIGINATOR
  ])('rejects an origin outside the external trust boundary: %s', raw => {
    expect(() => parseExternalOrigin(raw)).toThrow()
  })

  it('keeps the internal authority outside the hostname namespace', () => {
    expect(ADMIN_ORIGINATOR).toContain(':')
    expect(() => new URL(`https://${ADMIN_ORIGINATOR}`)).toThrow()
  })
})
