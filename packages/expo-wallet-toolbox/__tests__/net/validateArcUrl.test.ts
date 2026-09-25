import { validateArcUrl } from '../../core/net/validateArcUrl'

describe('XR-064: validateArcUrl', () => {
  it('accepts https URLs', () => {
    expect(validateArcUrl('https://arc.taal.com')).toBe(true)
    expect(validateArcUrl('https://example.com:8443/v1/tx')).toBe(true)
  })

  it('rejects a plaintext http URL to a real host', () => {
    expect(validateArcUrl('http://example.com')).toBe(false)
    expect(validateArcUrl('http://arc.taal.com/v1/tx')).toBe(false)
  })

  it('allows the explicit loopback dev exception', () => {
    expect(validateArcUrl('http://localhost:9090')).toBe(true)
    expect(validateArcUrl('http://127.0.0.1:9090/v1/tx')).toBe(true)
  })

  it('rejects other insecure or unusual schemes', () => {
    expect(validateArcUrl('ftp://example.com')).toBe(false)
    expect(validateArcUrl('ws://example.com')).toBe(false)
  })

  it('rejects unparsable input', () => {
    expect(validateArcUrl('not a url')).toBe(false)
  })

  it('treats an empty/blank string as valid (clears the override)', () => {
    expect(validateArcUrl('')).toBe(true)
    expect(validateArcUrl('   ')).toBe(true)
  })
})
