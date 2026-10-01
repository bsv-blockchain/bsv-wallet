import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { deriveProfileKeys, hdFromMnemonic } from '../../core/mnemonicWallet'
import { authPostFor, derivePushProfileKeys, makePushProfile } from '../../core/push/identities'

const mockAuthFetch = jest.fn()
const mockAuthFetchCtor = jest.fn()
jest.mock('@bsv/sdk', () => {
  const actual = jest.requireActual('@bsv/sdk')
  return {
    ...actual,
    AuthFetch: class {
      constructor(...args: unknown[]) {
        mockAuthFetchCtor(...args)
      }
      fetch(...args: unknown[]) {
        return mockAuthFetch(...args)
      }
    }
  }
})

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('derivePushProfileKeys', () => {
  it("gives each profile the primary key (m/0'/n') the wallet itself would build with", () => {
    const hd = hdFromMnemonic(MNEMONIC)
    const keys = derivePushProfileKeys(MNEMONIC, [0, 2, 5])
    expect(keys.map(k => k.index)).toEqual([0, 2, 5])
    for (const { index, primaryKey } of keys) {
      expect(new PrivateKey(primaryKey).toPublicKey().toString()).toBe(deriveProfileKeys(hd, index).identityKey)
      expect(primaryKey).toEqual(deriveProfileKeys(hd, index).primaryKey)
    }
  })

  it('derives no more than it was asked for, and never the privileged key', () => {
    expect(derivePushProfileKeys(MNEMONIC, [])).toEqual([])
    const [only] = derivePushProfileKeys(MNEMONIC, [1])
    expect(Object.keys(only).sort()).toEqual(['index', 'primaryKey'])
  })

  it('refuses a mnemonic that is not one', () => {
    expect(() => derivePushProfileKeys('not a mnemonic', [0])).toThrow()
  })
})

describe('makePushProfile', () => {
  it("signs in as the same identity the profile's own wallet has", async () => {
    const hd = hdFromMnemonic(MNEMONIC)
    for (const index of [0, 1, 7]) {
      const { primaryKey, identityKey } = deriveProfileKeys(hd, index)
      const profile = makePushProfile(index, primaryKey)
      expect(profile.index).toBe(index)
      expect(profile.identityKey).toBe(identityKey)
      // And the one the built wallet reports: WalletContext builds its KeyDeriver from this same key.
      expect(new KeyDeriver(new PrivateKey(primaryKey)).identityKey).toBe(identityKey)
      // What BRC-103 authentication reads from the wallet: the same key, not just the same string.
      const seen = await (
        profile.wallet as { getPublicKey: (a: object) => Promise<{ publicKey: string }> }
      ).getPublicKey({
        identityKey: true
      })
      expect(seen.publicKey).toBe(identityKey)
    }
  })

  it('different profiles are different identities', () => {
    const hd = hdFromMnemonic(MNEMONIC)
    const a = makePushProfile(0, deriveProfileKeys(hd, 0).primaryKey)
    const b = makePushProfile(1, deriveProfileKeys(hd, 1).primaryKey)
    expect(a.identityKey).not.toBe(b.identityKey)
  })
})

describe('authPostFor', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset()
    mockAuthFetchCtor.mockReset()
  })

  it("posts JSON through an AuthFetch built from that profile's wallet, and returns only the status", async () => {
    const hd = hdFromMnemonic(MNEMONIC)
    const profile = makePushProfile(1, deriveProfileKeys(hd, 1).primaryKey)
    mockAuthFetch.mockResolvedValue({ status: 200, text: async () => 'never read' })
    const post = authPostFor(profile.wallet)
    const answer = await post('https://mb.example.org/unregisterDevice', { fcmToken: 'tok1' })
    expect(answer).toEqual({ status: 200 })
    expect(mockAuthFetchCtor).toHaveBeenCalledTimes(1)
    expect(mockAuthFetchCtor.mock.calls[0][0]).toBe(profile.wallet)
    expect(mockAuthFetch).toHaveBeenCalledWith('https://mb.example.org/unregisterDevice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fcmToken: 'tok1' })
    })
  })

  it('reports a non-2xx answer as its status rather than throwing', async () => {
    const profile = makePushProfile(0, deriveProfileKeys(hdFromMnemonic(MNEMONIC), 0).primaryKey)
    mockAuthFetch.mockResolvedValue({ status: 404 })
    expect(await authPostFor(profile.wallet)('https://mb.example.org/unregisterDevice', { fcmToken: 't' })).toEqual({
      status: 404
    })
  })

  it('lets a transport failure through for the caller to contain', async () => {
    const profile = makePushProfile(0, deriveProfileKeys(hdFromMnemonic(MNEMONIC), 0).primaryKey)
    mockAuthFetch.mockRejectedValue(new Error('network down'))
    await expect(authPostFor(profile.wallet)('https://mb.example.org/x', { fcmToken: 't' })).rejects.toThrow(
      'network down'
    )
  })
})
