import { extractExpoPathFromURL } from 'expo-router/build/fork/extractPathFromURL'
import { redirectSystemPath } from '../app/+native-intent'

const params = {
  topic: 'session+with&reserved%characters',
  backendIdentityKey: '02' + 'a'.repeat(64),
  protocolID: JSON.stringify([2, 'pairing & browser']),
  origin: 'https://app.example/return?state=one&next=two%20three',
  expiry: '9999999999',
  sig: 'signature+with/slashes=&percent%25'
}
const pairingQuery = new URLSearchParams(params).toString()

describe.each([true, false])('native links (initial: %s)', initial => {
  it.each(['bsv-wallet', 'bsv-browser', 'BSV-WALLET', 'BSV-BROWSER'])(
    'routes external %s pairing links straight to /pair, unchanged — Approve/Reject lives there',
    scheme => {
      const result = redirectSystemPath({ path: `${scheme}://pair?${pairingQuery}`, initial })

      expect(result).toBe(`/pair?${pairingQuery}`)
      // Exercise the installed router's next parsing stage. Full custom URLs
      // are decoded there, while the relative result keeps reserved bytes safe.
      const routerPath = extractExpoPathFromURL([], result)
      const parsed = new URL(routerPath, 'https://wallet.test/')
      expect(parsed.pathname).toBe('/pair')
      expect(Object.fromEntries(parsed.searchParams)).toEqual(params)
    }
  )

  it.each(['bsv-wallet', 'bsv-browser'])('supports root, nested and triple-slash %s routes', scheme => {
    expect(redirectSystemPath({ path: `${scheme}://`, initial })).toBe('/')
    expect(redirectSystemPath({ path: `${scheme}://auth/mnemonic?flow=backup`, initial })).toBe('/auth/mnemonic?flow=backup')
    expect(redirectSystemPath({ path: `${scheme}:///auth/mnemonic?flow=backup`, initial })).toBe('/auth/mnemonic?flow=backup')
    expect(redirectSystemPath({ path: `${scheme}:///pair/?${pairingQuery}`, initial })).toBe(`/pair/?${pairingQuery}`)
  })

  it.each(['bsv-wallet', 'bsv-browser'])('preserves a mixed-case pairing host for %s links (no rewrite to fold case)', scheme => {
    expect(redirectSystemPath({ path: `${scheme}://PaIr?${pairingQuery}`, initial })).toBe(`/PaIr?${pairingQuery}`)
  })

  it.each(['pairing', 'pair-other', 'pair/nested', 'pair.example'])('passes an unrelated %s route straight through', route => {
    expect(redirectSystemPath({ path: `bsv-browser://${route}?${pairingQuery}`, initial })).toBe(`/${route}?${pairingQuery}`)
  })

  describe('destructive recovery routes — refused regardless of wallet scheme', () => {
    it.each(['bsv-wallet', 'bsv-browser'])('redirects %s auth/scan-shares to /', scheme => {
      expect(redirectSystemPath({ path: `${scheme}://auth/scan-shares`, initial })).toBe('/')
      expect(redirectSystemPath({ path: `${scheme}://auth/scan-shares?foo=bar`, initial })).toBe('/')
    })

    it.each(['bsv-wallet', 'bsv-browser'])('redirects %s auth/mnemonic?flow=import to /', scheme => {
      expect(redirectSystemPath({ path: `${scheme}://auth/mnemonic?flow=import`, initial })).toBe('/')
      expect(redirectSystemPath({ path: `${scheme}://auth/mnemonic?flow=IMPORT`, initial })).toBe('/')
    })

    it('still passes auth/mnemonic?flow=backup straight through', () => {
      expect(redirectSystemPath({ path: 'bsv-wallet://auth/mnemonic?flow=backup', initial })).toBe(
        '/auth/mnemonic?flow=backup'
      )
    })
  })

  it('preserves PeerPay payloads and the payment destination', () => {
    const path = 'peerpay:alice@example.com?amount=0.01&message=hello%20world'
    expect(redirectSystemPath({ path, initial })).toBe(`/pay?cell=pay-handle&peerpay=${encodeURIComponent(path)}`)
  })

  it('leaves internal approval routes and unrelated schemes unchanged', () => {
    const approvalPath = `/pair?${pairingQuery}`
    const devPath = 'exp+bsv-wallet://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'
    expect(redirectSystemPath({ path: approvalPath, initial })).toBe(approvalPath)
    expect(redirectSystemPath({ path: '/Pair', initial })).toBe('/Pair')
    expect(redirectSystemPath({ path: devPath, initial })).toBe(devPath)
    expect(redirectSystemPath({ path: '', initial })).toBe('/')
  })
})
