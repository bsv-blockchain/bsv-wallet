/** @jest-environment node */
const { resolveScheme } = require('../../plugin/validate')
const { hostConfig } = require('./support')

describe('resolveScheme', () => {
  test('default scheme is the package plus .bridge', () => {
    expect(resolveScheme(hostConfig(), {})).toBe('org.bsvblockchain.wallet.bridge')
  })

  test('explicit scheme bsv-wallet-bridge is used', () => {
    expect(resolveScheme(hostConfig(), { scheme: 'bsv-wallet-bridge' })).toBe('bsv-wallet-bridge')
  })

  test('uppercase, spaced or host-colliding scheme throws a named error', () => {
    expect(() => resolveScheme(hostConfig(), { scheme: 'Bsv-Bridge' })).toThrow(/AndroidWalletBridge: .*lowercase/)
    expect(() => resolveScheme(hostConfig(), { scheme: 'bsv bridge' })).toThrow(
      /AndroidWalletBridge: .*not a valid scheme/
    )
    expect(() => resolveScheme(hostConfig(), { scheme: '1bridge' })).toThrow(/AndroidWalletBridge/)
    expect(() => resolveScheme(hostConfig(), { scheme: '' })).toThrow(/AndroidWalletBridge/)
    expect(() => resolveScheme(hostConfig(), { scheme: 'https' })).toThrow(/reserved/)
    // the Expo scheme list
    expect(() => resolveScheme(hostConfig(), { scheme: 'bsv-wallet' })).toThrow(
      /AndroidWalletBridge: .*already declared/
    )
    // android.intentFilters data
    const cfg = hostConfig()
    cfg.android.intentFilters = [{ action: 'VIEW', data: [{ scheme: 'bitcoin' }] }]
    expect(() => resolveScheme(cfg, { scheme: 'bitcoin' })).toThrow(/already declared/)
    // a string scheme
    expect(() => resolveScheme({ scheme: 'solo', android: { package: 'a.b' } }, { scheme: 'solo' })).toThrow(
      /already declared/
    )
  })

  test('android.package is required', () => {
    expect(() => resolveScheme({}, {})).toThrow(/AndroidWalletBridge: android.package is required/)
  })
})
