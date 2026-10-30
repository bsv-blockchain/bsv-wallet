import { parseHandoffUrl } from '../src/handoffUrl'

const S = 'org.bsvblockchain.wallet'

describe('parseHandoffUrl', () => {
  it.each([
    ['accepts the canonical URL', `${S}://bridge?v=1&n=abc`, true],
    ['accepts without a nonce', `${S}://bridge?v=1`, true],
    ['ignores extra params and the nonce value', `${S}://bridge?x=1&v=1&n=%00%ff&y`, true],
    ['accepts a trailing slash and a fragment', `${S}://bridge/?v=1#frag`, true],
    ['scheme compare is case-insensitive', `ORG.BSVBLOCKCHAIN.WALLET://bridge?v=1`, true],
    ['wrong scheme', `other.app://bridge?v=1&n=abc`, false],
    ['wrong host', `${S}://pay?v=1`, false],
    ['host with a suffix', `${S}://bridge.evil?v=1`, false],
    ['v missing', `${S}://bridge?n=abc`, false],
    ['no query', `${S}://bridge`, false],
    ['v=2', `${S}://bridge?v=2&n=abc`, false],
    ['v=1 only inside another param', `${S}://bridge?xv=1&n=v=1`, false],
    ['conflicting duplicate v', `${S}://bridge?v=1&v=2`, false],
    ['a path segment', `${S}://bridge/extra?v=1`, false],
    ['not a URL', `bridge?v=1`, false],
    ['empty', ``, false]
  ])('%s', (_name, url, ok) => {
    expect(parseHandoffUrl(url, S)).toBe(ok)
  })

  it('refuses an empty configured scheme', () => {
    expect(parseHandoffUrl('://bridge?v=1', '')).toBe(false)
  })
})
