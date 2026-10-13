import { isSignInCode, pairLinkFromParams, readSignInCode } from '../src/signin/code'

const NOW = 1_800_000_000_000
const code = (over: Record<string, string> = {}) => {
  const p = new URLSearchParams({
    topic: 'abcDEF123_-topic',
    backendIdentityKey: '02' + 'ab'.repeat(32),
    protocolID: JSON.stringify([2, 'wallet pairing']),
    origin: 'https://www.bsvradar.com',
    expiry: String(NOW / 1000 + 300),
    // well formed; checked against the site's key when connecting
    sig: 'MEUC' + 'A'.repeat(91),
    ...over
  })
  return `bsv-wallet://pair?${p.toString()}`
}

describe('a website’s sign-in code', () => {
  it('is told apart from other codes', () => {
    expect(isSignInCode(code())).toBe(true)
    expect(isSignInCode('peerpay:02ab')).toBe(false)
  })

  it('reads as the site, without www.', () => {
    const r = readSignInCode(code(), NOW)
    expect('code' in r && r.code.domain).toBe('bsvradar.com')
    expect('code' in r && r.code.origin).toBe('https://www.bsvradar.com')
  })

  it('is refused once expired, from another app, or with a bad origin', () => {
    expect(readSignInCode(code({ expiry: String(NOW / 1000 - 1) }), NOW)).toEqual({
      error: expect.stringMatching(/expired/)
    })
    expect('error' in readSignInCode('https://example.com/pair?topic=x', NOW)).toBe(true)
    expect('error' in readSignInCode(code({ origin: 'javascript:alert(1)' }), NOW)).toBe(true)
  })
})

describe('a sign-in link opened from outside the app', () => {
  it('reads back as the same code from its route params', () => {
    const link = code()
    const params = Object.fromEntries(new URL(link).searchParams)
    const back = pairLinkFromParams(params)
    expect(readSignInCode(back, NOW)).toEqual(readSignInCode(link, NOW))
    expect('code' in readSignInCode(back, NOW)).toBe(true)
  })
})
