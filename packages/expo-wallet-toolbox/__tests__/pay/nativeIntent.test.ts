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
    'routes external %s pairing links straight to /pair, unchanged — Approve/Reject lives there, not on Connections',
    scheme => {
      const result = resolveNativeIntent(`${scheme}://pair?${pairingQuery}`, { walletSchemes })
      expect(result).toBe(`/pair?${pairingQuery}`)
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
    expect(resolveNativeIntent(`${scheme}:///pair/?${pairingQuery}`, { walletSchemes })).toBe(`/pair/?${pairingQuery}`)
  })

  it.each(['bsv-wallet', 'bsv-browser'])(
    'preserves a mixed-case pairing host for %s links (no rewrite to fold case)',
    scheme => {
      expect(resolveNativeIntent(`${scheme}://PaIr?${pairingQuery}`, { walletSchemes })).toBe(`/PaIr?${pairingQuery}`)
    }
  )

  it.each(['pairing', 'pair-other', 'pair/nested', 'pair.example'])(
    'passes an unrelated %s route straight through',
    route => {
      expect(resolveNativeIntent(`bsv-browser://${route}?${pairingQuery}`, { walletSchemes })).toBe(
        `/${route}?${pairingQuery}`
      )
    }
  )

  describe('destructive recovery routes — refused regardless of wallet scheme', () => {
    it.each(['bsv-wallet', 'bsv-browser'])(
      'redirects %s auth/scan-shares to / — it overwrites the stored secret with no confirmation',
      scheme => {
        expect(resolveNativeIntent(`${scheme}://auth/scan-shares`, { walletSchemes })).toBe('/')
        expect(resolveNativeIntent(`${scheme}://auth/scan-shares?foo=bar`, { walletSchemes })).toBe('/')
        expect(resolveNativeIntent(`${scheme}://AUTH/SCAN-SHARES`, { walletSchemes })).toBe('/')
      }
    )

    it.each(['bsv-wallet', 'bsv-browser'])('redirects %s auth/mnemonic?flow=import to /', scheme => {
      expect(resolveNativeIntent(`${scheme}://auth/mnemonic?flow=import`, { walletSchemes })).toBe('/')
      expect(resolveNativeIntent(`${scheme}://auth/mnemonic?flow=IMPORT`, { walletSchemes })).toBe('/')
      expect(resolveNativeIntent(`${scheme}://auth/mnemonic?other=1&flow=import`, { walletSchemes })).toBe('/')
    })

    it('still passes auth/mnemonic?flow=backup straight through — it only reads/displays, never overwrites', () => {
      expect(resolveNativeIntent('bsv-wallet://auth/mnemonic?flow=backup', { walletSchemes })).toBe(
        '/auth/mnemonic?flow=backup'
      )
    })

    it('matches the route exactly, not as a prefix', () => {
      expect(resolveNativeIntent('bsv-wallet://auth/scan-shares-other', { walletSchemes })).toBe(
        '/auth/scan-shares-other'
      )
      expect(resolveNativeIntent('bsv-wallet://auth/mnemonics?flow=import', { walletSchemes })).toBe(
        '/auth/mnemonics?flow=import'
      )
    })

    it('leaves auth/mnemonic alone when flow=import is absent', () => {
      expect(resolveNativeIntent('bsv-wallet://auth/mnemonic', { walletSchemes })).toBe('/auth/mnemonic')
      expect(resolveNativeIntent('bsv-wallet://auth/mnemonic?flow=export', { walletSchemes })).toBe(
        '/auth/mnemonic?flow=export'
      )
    })
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
      `/pair?${pairingQuery}`
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
      `/pair?${pairingQuery}`
    )
    // The unescaped '.' would also match this — the escaped pattern must not.
    expect(resolveNativeIntent(`acmeXpay://pair?${pairingQuery}`, { walletSchemes: metaSchemes })).toBe(
      `acmeXpay://pair?${pairingQuery}`
    )
  })
})
