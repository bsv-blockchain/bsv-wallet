import { resolveNativeIntent } from '../../core/pay/rails/nativeIntent'

const params = {
  topic: 'session+with&reserved%characters',
  backendIdentityKey: '02' + 'a'.repeat(64),
  protocolID: JSON.stringify([2, 'pairing & browser']),
  origin: 'https://app.example/return?state=one&next=two%20three',
  expiry: '9999999999',
  sig: 'signature+with/slashes=&percent%25'
}
const pairingQuery = new URLSearchParams(params).toString()

const walletSchemes = ['bsv-wallet', 'bsv-browser']

describe('resolveNativeIntent — native links', () => {
  it.each(['bsv-wallet', 'bsv-browser', 'BSV-WALLET', 'BSV-BROWSER'])(
    'routes external %s pairing links to Connections without changing their payload',
    scheme => {
      const result = resolveNativeIntent(`${scheme}://pair?${pairingQuery}`, { walletSchemes })
      expect(result).toBe(`/connections?${pairingQuery}`)
    }
  )

  it.each(['bsv-wallet', 'bsv-browser'])('supports root, nested and triple-slash %s routes', scheme => {
    expect(resolveNativeIntent(`${scheme}://`, { walletSchemes })).toBe('/')
    expect(resolveNativeIntent(`${scheme}://auth/mnemonic?flow=backup`, { walletSchemes })).toBe(
      '/auth/mnemonic?flow=backup'
    )
    expect(resolveNativeIntent(`${scheme}:///auth/mnemonic?flow=backup`, { walletSchemes })).toBe(
      '/auth/mnemonic?flow=backup'
    )
    expect(resolveNativeIntent(`${scheme}:///pair/?${pairingQuery}`, { walletSchemes })).toBe(
      `/connections?${pairingQuery}`
    )
  })

  it.each(['bsv-wallet', 'bsv-browser'])('accepts a mixed-case pairing host for %s links', scheme => {
    expect(resolveNativeIntent(`${scheme}://PaIr?${pairingQuery}`, { walletSchemes })).toBe(
      `/connections?${pairingQuery}`
    )
  })

  it.each(['pairing', 'pair-other', 'pair/nested', 'pair.example'])('does not treat the %s route as pairing', route => {
    expect(resolveNativeIntent(`bsv-browser://${route}?${pairingQuery}`, { walletSchemes })).toBe(
      `/${route}?${pairingQuery}`
    )
  })

  it('preserves PeerPay payloads and the payment destination', () => {
    const path = 'peerpay:alice@example.com?amount=0.01&message=hello%20world'
    expect(resolveNativeIntent(path, { walletSchemes })).toBe(
      `/pay?cell=pay-handle&peerpay=${encodeURIComponent(path)}`
    )
  })

  it('leaves internal approval routes and unrelated schemes unchanged', () => {
    const approvalPath = `/pair?${pairingQuery}`
    const devPath = 'exp+bsv-wallet://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'
    expect(resolveNativeIntent(approvalPath, { walletSchemes })).toBe(approvalPath)
    expect(resolveNativeIntent('/Pair', { walletSchemes })).toBe('/Pair')
    expect(resolveNativeIntent(devPath, { walletSchemes })).toBe(devPath)
    expect(resolveNativeIntent('', { walletSchemes })).toBe('/')
  })
})

describe('resolveNativeIntent — a second wallet app with different schemes', () => {
  const customSchemes = ['acme-pay', 'acme-browser']

  it('routes pairing links for its own schemes, not the default bsv-wallet ones', () => {
    expect(resolveNativeIntent(`acme-pay://pair?${pairingQuery}`, { walletSchemes: customSchemes })).toBe(
      `/connections?${pairingQuery}`
    )
    // A scheme this app doesn't own falls through to the generic path/fallback rule.
    expect(resolveNativeIntent(`bsv-wallet://pair?${pairingQuery}`, { walletSchemes: customSchemes })).toBe(
      `bsv-wallet://pair?${pairingQuery}`
    )
  })

  it('still recognises peerpay: links regardless of wallet schemes — the toolbox owns that protocol', () => {
    const path = `peerpay:${'02' + 'a'.repeat(64)}?sats=250`
    expect(resolveNativeIntent(path, { walletSchemes: customSchemes })).toBe(
      `/pay?cell=pay-handle&peerpay=${encodeURIComponent(path)}`
    )
  })

  it('escapes regex metacharacters in a wallet scheme instead of treating them as a pattern', () => {
    // A scheme containing a '.' must match only that literal character, not "any character".
    const metaSchemes = ['acme.pay']
    expect(resolveNativeIntent(`acme.pay://pair?${pairingQuery}`, { walletSchemes: metaSchemes })).toBe(
      `/connections?${pairingQuery}`
    )
    // The unescaped '.' would also match this — the escaped pattern must not.
    expect(resolveNativeIntent(`acmeXpay://pair?${pairingQuery}`, { walletSchemes: metaSchemes })).toBe(
      `acmeXpay://pair?${pairingQuery}`
    )
  })
})
