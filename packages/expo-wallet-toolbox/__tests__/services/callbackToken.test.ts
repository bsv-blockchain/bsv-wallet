import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { deriveCallbackToken } from '../../core/services/callbackToken'

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
