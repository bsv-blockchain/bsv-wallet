/** @jest-environment node */
const { deriveIds } = require('../../plugin/ids')

describe('deriveIds', () => {
  test('ids derives every value for org.bsvblockchain.wallet and two different bundle ids never collide', () => {
    expect(deriveIds('org.bsvblockchain.wallet')).toEqual({
      scheme: 'org.bsvblockchain.wallet',
      extensionBundleId: 'org.bsvblockchain.wallet.safari',
      appGroup: 'group.org.bsvblockchain.wallet',
      bridgeKeychainGroup: '$(AppIdentifierPrefix)org.bsvblockchain.wallet.bridge',
      hostKeychainGroup: '$(AppIdentifierPrefix)org.bsvblockchain.wallet',
      transportId: 'safari-extension'
    })
    const a = deriveIds('com.example.One')
    const b = deriveIds('com.example.Two')
    expect(a.scheme).toBe('com.example.one')
    for (const key of ['scheme', 'extensionBundleId', 'appGroup', 'bridgeKeychainGroup', 'hostKeychainGroup']) {
      expect(a[key]).not.toBe(b[key])
    }
  })

  test('rejects a bundle id that is not reverse-domain', () => {
    expect(() => deriveIds('wallet')).toThrow('SafariBridge')
    expect(() => deriveIds(undefined)).toThrow('SafariBridge')
  })

  test('override is checked against the same constraints', () => {
    const B = 'org.bsvblockchain.wallet'
    expect(deriveIds(B, { overrides: { appGroup: 'group.shared.wallet' } }).appGroup).toBe('group.shared.wallet')
    expect(() => deriveIds(B, { overrides: { appGroup: 'shared.wallet' } })).toThrow('appGroup')
    expect(() => deriveIds(B, { overrides: { scheme: 'Not A Scheme' } })).toThrow('scheme')
    expect(() => deriveIds(B, { overrides: { scheme: 'https' } })).toThrow('scheme')
    expect(() => deriveIds(B, { overrides: { extensionBundleId: 'com.other.safari' } })).toThrow('extensionBundleId')
    expect(() => deriveIds(B, { overrides: { transportId: 'extension' } })).toThrow('transportId')
    expect(() => deriveIds(B, { overrides: { bridgeKeychainGroup: 'org.bsvblockchain.wallet.bridge' } })).toThrow(
      'bridgeKeychainGroup'
    )
    expect(() => deriveIds(B, { overrides: { bridgeKeychainGroup: '$(AppIdentifierPrefix)' + B } })).toThrow(
      'bridgeKeychainGroup'
    )
  })
})
