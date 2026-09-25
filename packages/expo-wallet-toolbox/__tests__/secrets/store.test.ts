/**
 * Secret store: everything after the one unlock must be prompt-free, and
 * deletion must work without a key.
 */
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import { fake as secureStore } from '../__mocks__/secureStoreFake'
import { fake as localAuth } from '../__mocks__/localAuthFake'
import { __resetForTests, readSentinel, unlockKek } from '../../core/services/secrets/kek'
import {
  deleteAllSecrets,
  deleteSecret,
  getSecret,
  hasAnySecret,
  hasSecret,
  putSecret
} from '../../core/services/secrets/store'
import { readLegacySecret } from '../../core/services/secrets/migration'

const ENV_SERVICE = 'bsvb.secrets.v1'
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const WIF = 'L1uyy5qTuGrVXrmrsvHWHgVzW9kKdrp27wBC7Vs6nZDTF2BRUVwy'

describe('secret store', () => {
  beforeEach(() => {
    secureStore.__reset()
    localAuth.__reset()
    __resetForTests()
    ;(global as any).__DEV__ = false
  })

  it('stores ciphertext, never the plaintext', async () => {
    expect(await putSecret('mnemonic', MNEMONIC)).toBe(true)
    const stored = secureStore.__get('envV1.mnemonic', { service: ENV_SERVICE })
    expect(stored).toBeDefined()
    expect(stored).not.toContain('abandon')
    const blob = JSON.parse(stored as string)
    expect(blob).toMatchObject({ v: 1 })
    expect(typeof blob.c).toBe('string')
  })

  it('writes envelopes unauthenticated, so reading them never prompts', async () => {
    await putSecret('mnemonic', MNEMONIC)
    for (const opts of secureStore.__optionsFor('set', 'envV1.mnemonic')) {
      expect(opts).toMatchObject({ keychainService: ENV_SERVICE, requireAuthentication: false })
    }
  })

  it('costs exactly one ceremony for a whole session of reads and writes', async () => {
    await putSecret('mnemonic', MNEMONIC)
    await putSecret('recoveredKey', WIF)
    __resetForTests() // fresh process, storage intact
    secureStore.__clearPrompts()

    expect((await unlockKek()).status).toBe('unlocked')
    expect(await getSecret('mnemonic')).toBe(MNEMONIC)
    expect(await getSecret('recoveredKey')).toBe(WIF)
    expect(await getSecret('mnemonic')).toBe(MNEMONIC)
    await putSecret('mnemonic', MNEMONIC)
    await hasSecret('mnemonic')

    expect(secureStore.__prompts()).toBe(1)
  })

  it('returns null while locked and does not unlock implicitly', async () => {
    await putSecret('mnemonic', MNEMONIC)
    __resetForTests()
    secureStore.__clearPrompts()

    // The one automatic unlock belongs to the wallet-build path, not to
    // whichever screen happens to read a secret first.
    expect(await getSecret('mnemonic')).toBeNull()
    expect(secureStore.__prompts()).toBe(0)
  })

  it('answers hasSecret while locked, without a ceremony', async () => {
    await putSecret('mnemonic', MNEMONIC)
    __resetForTests()
    secureStore.__clearPrompts()

    expect(await hasSecret('mnemonic')).toBe(true)
    expect(await hasSecret('recoveredKey')).toBe(false)
    expect(secureStore.__prompts()).toBe(0)
  })

  it('refuses to provision a fresh KEK when the sentinel read merely fails (P2-store-transient-sentinel)', async () => {
    secureStore.getItemAsync.mockRejectedValueOnce(new Error('keychain unavailable'))
    secureStore.setItemAsync.mockClear()

    expect(await putSecret('mnemonic', MNEMONIC)).toBe(false)
    // The single most important negative assertion: a transient read failure
    // must never take the provisionKek() branch, which deletes both KEK
    // keychain items before minting a new one.
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled()
    expect(secureStore.setItemAsync).not.toHaveBeenCalled()
  })

  it('XR-109: refuses to provision a fresh KEK when the sentinel is present but the wrong shape', async () => {
    await putSecret('recoveredKey', WIF) // an existing, live envelope + KEK
    __resetForTests()
    secureStore.__clearPrompts()
    // A parseable-but-wrong-shape sentinel (truncated write, rolled-back
    // version, ...) — not a rejected read, not unparseable JSON, both of
    // which are already handled.
    secureStore.__overrideRead('secretsSentinelV1', JSON.stringify({ v: 2, kekId: 'x' }))
    secureStore.setItemAsync.mockClear()
    secureStore.deleteItemAsync.mockClear()

    expect(await putSecret('mnemonic', MNEMONIC)).toBe(false)
    // The single most important negative assertion: a wrong-shape sentinel
    // must never take the provisionKek() branch, which deletes both KEK
    // keychain items before minting a new one — orphaning the still-live
    // recoveredKey envelope sealed under the real KEK.
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled()
    expect(secureStore.setItemAsync).not.toHaveBeenCalled()
  })

  it('still provisions normally when the sentinel is genuinely absent (no regression to fresh-install)', async () => {
    expect(await putSecret('mnemonic', MNEMONIC)).toBe(true)
    expect(await hasSecret('mnemonic')).toBe(true)
  })

  it('propagates encrypted keychain read failures for creation checks', async () => {
    secureStore.getItemAsync.mockRejectedValueOnce(new Error('keychain unavailable'))
    await expect(hasAnySecret({ strict: true })).rejects.toThrow('keychain unavailable')
  })

  it('propagates legacy keychain read failures for creation checks', async () => {
    secureStore.getItemAsync.mockRejectedValueOnce(new Error('keychain unavailable'))
    await expect(readLegacySecret('mnemonic', { strict: true })).rejects.toThrow('keychain unavailable')
  })

  it('refuses to open a blob sealed by a different KEK', async () => {
    await putSecret('mnemonic', MNEMONIC)
    const blob = JSON.parse(secureStore.__get('envV1.mnemonic', { service: ENV_SERVICE }) as string)
    secureStore.__seed('envV1.mnemonic', JSON.stringify({ ...blob, kekId: 'ffffffffffffffff' }), {
      service: ENV_SERVICE
    })
    expect(await getSecret('mnemonic')).toBeNull()
  })

  it('deletes a secret without a ceremony and forgets it in the sentinel', async () => {
    await putSecret('mnemonic', MNEMONIC)
    await putSecret('recoveredKey', WIF)
    secureStore.__clearPrompts()

    await deleteSecret('recoveredKey')
    expect(await hasSecret('recoveredKey')).toBe(false)
    expect(await hasSecret('mnemonic')).toBe(true)
    expect((await readSentinel())?.names).toEqual(['mnemonic'])
    expect(secureStore.__prompts()).toBe(0)
  })

  it('logs out a user whose biometrics changed — deletion needs no key', async () => {
    await putSecret('mnemonic', MNEMONIC)
    __resetForTests()
    secureStore.__invalidateBiometrics()
    expect((await unlockKek()).status).toBe('lost')
    secureStore.__clearPrompts()

    await deleteAllSecrets()

    expect(await hasSecret('mnemonic')).toBe(false)
    expect(await readSentinel()).toBeNull()
    expect(secureStore.__prompts()).toBe(0)
  })

  it('XR-107: erases a surviving legacy plaintext secret when the wallet is deleted', async () => {
    await putSecret('mnemonic', MNEMONIC)
    // A pre-envelope plaintext that migration never touched (e.g. a
    // recoveredKey the user never actually had, or a leftover from a crash
    // between commit and sweep) must not survive "Delete Wallet".
    secureStore.__seed('recoveredKey', WIF)

    await deleteAllSecrets()

    expect(await readLegacySecret('recoveredKey')).toBeNull()
    expect(await hasSecret('mnemonic')).toBe(false)
    // A verified-clean wipe must say so — the caller (Delete Wallet) relies
    // on this to know it may report success and navigate away.
    expect(await deleteAllSecrets()).toBe(true)
  })

  it('XR-107: reports failure (does not claim erasure) when a legacy secret survives deletion', async () => {
    await putSecret('mnemonic', MNEMONIC)
    secureStore.__seed('recoveredKey', WIF)
    // A persistent SecureStore delete failure: the item keeps reading back
    // as present no matter how many times deleteItemAsync is called on it —
    // this is the "iOS discards the OSStatus" scenario sweepLegacyKeys()
    // exists to catch.
    secureStore.__overrideRead('recoveredKey', WIF)

    const erased = await deleteAllSecrets()

    // The caller MUST be told this did not verify clean, so it can fail
    // closed (report an error, offer retry) instead of behaving as though
    // "Delete Wallet" fully succeeded while a spend-capable secret survives.
    expect(erased).toBe(false)
  })

  it('leaves the next launch looking like a clean install after a wipe', async () => {
    await putSecret('mnemonic', MNEMONIC)
    await deleteAllSecrets()
    __resetForTests()
    secureStore.__clearPrompts()

    // No orphan sentinel means no biometric sheet on the create-wallet screen.
    expect((await unlockKek()).status).toBe('absent')
    expect(secureStore.__prompts()).toBe(0)
  })
})
