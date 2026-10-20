// The package entry pulls in LocalStorageProvider's secrets stack, which
// touches these two native modules at import time (as in nearbyRail.test.ts).
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import { CachedKeyDeriver, KeyDeriver, PrivateKey } from '@bsv/sdk'
import { deriveCallbackToken } from '../../core/services/callbackToken'
import { deriveCallbackToken as exported } from '../../core'

const kd1 = new KeyDeriver(new PrivateKey(1))
const kd2 = new KeyDeriver(new PrivateKey(2))

describe('deriveCallbackToken', () => {
  it('is deterministic for the same key deriver', () => {
    expect(deriveCallbackToken(kd1)).toBe(deriveCallbackToken(kd1))
  })

  it('differs between two wallets with different keys', () => {
    expect(deriveCallbackToken(kd1)).not.toBe(deriveCallbackToken(kd2))
  })

  it('is not a prefix or substring of the public identity key', () => {
    const token = deriveCallbackToken(kd1)
    expect(kd1.identityKey.includes(token)).toBe(false)
    expect(kd1.identityKey.substring(0, 32)).not.toBe(token)
  })

  it('is a 32-char hex string', () => {
    expect(deriveCallbackToken(kd1)).toMatch(/^[0-9a-f]{32}$/)
  })
})

/**
 * Known-answer vectors shared with bsv-desktop (test/arcade.test.ts), which
 * derives the same token so a wallet open in both apps hears one Arcade status
 * stream. The second root key's derived key has a leading zero byte, which
 * pins the unpadded hashing.
 */
const VECTORS = [
  {
    rootKey: '0f'.repeat(32),
    identityKey: '021a7a569e91dbf60581509c7fc946d1003b60c7dee85299538db6353538d59574',
    token: '474583e93a591794b36961bc963e204a'
  },
  {
    rootKey: '2bb'.padStart(64, '0'),
    identityKey: '0337cf0ed288ed8fef4ae17bcff6bfb8153e12bab2a46d7e5d2e6feb999793bef8',
    token: 'dfa4a622f1a7b25d1acc9cacb4449443'
  }
]

describe('deriveCallbackToken known-answer vectors', () => {
  it.each(VECTORS)('derives $token from root key $rootKey', ({ rootKey, identityKey, token }) => {
    const keyDeriver = new KeyDeriver(PrivateKey.fromHex(rootKey))
    expect(keyDeriver.identityKey).toBe(identityKey)
    expect(deriveCallbackToken(keyDeriver)).toBe(token)
  })

  it.each(VECTORS)('derives the same token through a CachedKeyDeriver', ({ rootKey, token }) => {
    expect(deriveCallbackToken(new CachedKeyDeriver(PrivateKey.fromHex(rootKey)))).toBe(token)
  })

  it('is exported from the package entry', () => {
    expect(exported).toBe(deriveCallbackToken)
  })
})
