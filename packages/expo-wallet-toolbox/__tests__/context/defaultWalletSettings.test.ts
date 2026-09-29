import { Utils } from '@bsv/sdk'
import { validateWalletResult } from '@bsv/sdk/wallet/WalletResultValidation'
import { DEFAULT_SETTINGS as LIB_DEFAULT_SETTINGS } from '@bsv/wallet-toolbox-mobile'
import { DEFAULT_SETTINGS } from '../../core/context/defaultWalletSettings'

const certifiers = DEFAULT_SETTINGS.trustSettings.trustedCertifiers

// @bsv/sdk 2.8.8+ validates every discoverByAttributes/discoverByIdentityKey
// result against BRC-100, and the wallet copies each certifier's settings
// straight into certifierInfo. A shipped default outside the bounds makes
// every identity lookup that returns one of its certificates throw in the dApp.
test.each(certifiers.map(c => [c.name, c] as const))(
  '%s yields a certifierInfo the SDK accepts in a discovery result',
  (_name, certifier) => {
    const result = {
      totalCertificates: 1,
      certificates: [
        {
          type: Utils.toBase64(Array(32).fill(1)),
          serialNumber: Utils.toBase64(Array(32).fill(2)),
          subject: certifier.identityKey,
          certifier: certifier.identityKey,
          revocationOutpoint: `${'ab'.repeat(32)}.0`,
          signature: '3006020101020101',
          fields: {},
          publiclyRevealedKeyring: {},
          decryptedFields: { userName: 'deggen' },
          certifierInfo: {
            name: certifier.name,
            iconUrl: certifier.iconUrl,
            description: certifier.description,
            trust: certifier.trust
          }
        }
      ]
    }
    expect(() =>
      validateWalletResult('discoverByAttributes', result, { attributes: { userName: 'deggen' } })
    ).not.toThrow()
  }
)

test('keeps every library default certifier and the two this package adds', () => {
  const keys = certifiers.map(c => c.identityKey)
  for (const { identityKey } of LIB_DEFAULT_SETTINGS.trustSettings.trustedCertifiers) {
    expect(keys).toContain(identityKey)
  }
  expect(certifiers.map(c => c.name)).toEqual(expect.arrayContaining(['Who I Am', 'Sigma Identity']))
  expect(new Set(keys).size).toBe(keys.length)
})

test('changes only the description of a library default', () => {
  for (const libCertifier of LIB_DEFAULT_SETTINGS.trustSettings.trustedCertifiers) {
    const ours = certifiers.find(c => c.identityKey === libCertifier.identityKey)!
    const { description: _theirs, ...rest } = libCertifier
    expect(ours).toMatchObject(rest)
  }
})
