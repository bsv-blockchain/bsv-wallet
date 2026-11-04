/**
 * Migration off the legacy plaintext scheme.
 *
 * The ordering assertions here are the point: the legacy plaintext must
 * survive every failure mode, and must only be deleted after the envelope has
 * been written, read back and decrypted.
 */
// Own AsyncStorage mock, matching __tests__/backup/erase.test.ts and
// __tests__/vault/vaultStore.test.ts: requiring the real jest/async-storage-mock
// here collides with the root jest config's global moduleNameMapper for this
// package (both resolve to the same file), which recurses the module resolver
// into a stack overflow.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => {
        store[k] = v
      },
      removeItem: async (k: string) => {
        delete store[k]
      },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => {
        for (const k of keys) delete store[k]
      },
      clear: async () => {
        for (const k of Object.keys(store)) delete store[k]
      }
    }
  }
})
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import AsyncStorage from '@react-native-async-storage/async-storage'
import { fake as secureStore } from '../__mocks__/secureStoreFake'
import { fake as localAuth } from '../__mocks__/localAuthFake'
import { __resetForTests, readSentinel, unlockKek } from '../../core/services/secrets/kek'
import { migrateLegacySecrets } from '../../core/services/secrets/migration'
import { KEK_AUTH_KEY } from '../../core/services/secrets/policy'
import { SENTINEL_KEY, envOptions } from '../../core/services/secrets/storage'
import { getSecret, hasSecret } from '../../core/services/secrets/store'

const ENV_SERVICE = 'bsvb.secrets.v1'
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const WIF = 'L1uyy5qTuGrVXrmrsvHWHgVzW9kKdrp27wBC7Vs6nZDTF2BRUVwy'

/** Recreate what the pre-envelope provider left on disk. */
function seedLegacyInstall({ mnemonic = MNEMONIC, recoveredKey = '', password = '' } = {}) {
  if (mnemonic) secureStore.__seed('mnemonic', mnemonic)
  if (recoveredKey) secureStore.__seed('recoveredKey', recoveredKey)
  if (password) secureStore.__seed('password', password)
  return AsyncStorage.setItem('hasWalletKeys', 'true')
}

describe('legacy secret migration', () => {
  beforeEach(async () => {
    secureStore.__reset()
    localAuth.__reset()
    __resetForTests()
    await AsyncStorage.clear()
    ;(global as any).__DEV__ = false
  })

  it('migrates a legacy wallet and removes the plaintext', async () => {
    await seedLegacyInstall({ recoveredKey: WIF, password: 'hunter2' })

    const result = await migrateLegacySecrets()
    expect(result).toEqual({ outcome: 'migrated', names: ['mnemonic', 'recoveredKey'] })

    expect(secureStore.__has('mnemonic')).toBe(false)
    expect(secureStore.__has('recoveredKey')).toBe(false)
    expect(await AsyncStorage.getItem('hasWalletKeys')).toBeNull()
    expect(await hasSecret('mnemonic')).toBe(true)
    expect(await getSecret('mnemonic')).toBe(MNEMONIC)
    expect(await getSecret('recoveredKey')).toBe(WIF)
  })

  it('deletes the legacy password without ever sealing it', async () => {
    await seedLegacyInstall({ password: 'hunter2' })
    await migrateLegacySecrets()

    expect(secureStore.__has('password')).toBe(false)
    expect(secureStore.__has('envV1.password', { service: ENV_SERVICE })).toBe(false)
    expect((await readSentinel())?.names).toEqual(['mnemonic'])
  })

  it('verifies the envelope before it deletes anything', async () => {
    await seedLegacyInstall()
    await migrateLegacySecrets()

    const ops = secureStore.__ops()
    const wroteBlob = ops.indexOf('set:envV1.mnemonic')
    const readBack = ops.indexOf('get:envV1.mnemonic', wroteBlob + 1)
    const wroteSentinel = ops.lastIndexOf('set:secretsSentinelV1')
    const deletedLegacy = ops.indexOf('delete:mnemonic')

    expect(wroteBlob).toBeGreaterThanOrEqual(0)
    expect(readBack).toBeGreaterThan(wroteBlob)
    expect(wroteSentinel).toBeGreaterThan(readBack)
    expect(deletedLegacy).toBeGreaterThan(wroteSentinel)
  })

  it('keeps the plaintext and writes no sentinel when verification fails', async () => {
    await seedLegacyInstall()
    // Corrupt only the verification read-back, as a storage-layer bug would.
    const originalRead = secureStore.getItemAsync.getMockImplementation()!
    secureStore.getItemAsync.mockImplementation(async (key, options) => {
      if (key === 'envV1.mnemonic' && secureStore.__has(key, { service: ENV_SERVICE })) {
        return JSON.stringify({ v: 1, kekId: 'x', salt: 'aa', c: 'bb' })
      }
      return originalRead(key, options)
    })
    let result
    try {
      result = await migrateLegacySecrets()
    } finally {
      secureStore.getItemAsync.mockImplementation(originalRead)
    }

    expect(result).toMatchObject({ outcome: 'failed', stage: 'verify' })
    // The user still has a working wallet on the old scheme.
    expect(secureStore.__get('mnemonic')).toBe(MNEMONIC)
    expect(await readSentinel()).toBeNull()
    expect(secureStore.__has('envV1.mnemonic', { service: ENV_SERVICE })).toBe(false)
  })

  it('keeps the plaintext when the user cancels the provisioning prompt', async () => {
    await seedLegacyInstall()
    secureStore.__setOutcome('cancel')

    const result = await migrateLegacySecrets()

    expect(result).toMatchObject({ outcome: 'failed', stage: 'provision', retryable: true })
    expect(secureStore.__get('mnemonic')).toBe(MNEMONIC)
    expect(await readSentinel()).toBeNull()
  })

  it('retries on the next launch after a cancellation', async () => {
    await seedLegacyInstall()
    secureStore.__setOutcome('cancel')
    expect((await migrateLegacySecrets()).outcome).toBe('failed')

    secureStore.__setOutcome('ok')
    __resetForTests()
    expect((await migrateLegacySecrets()).outcome).toBe('migrated')
    expect(await getSecret('mnemonic')).toBe(MNEMONIC)
  })

  it('stops retrying after three failures instead of prompting every launch', async () => {
    await seedLegacyInstall()
    secureStore.__setOutcome('cancel')
    for (let i = 0; i < 3; i++) {
      __resetForTests()
      expect((await migrateLegacySecrets()).outcome).toBe('failed')
    }

    __resetForTests()
    secureStore.__clearPrompts()
    const result = await migrateLegacySecrets()
    expect(result).toMatchObject({ outcome: 'failed', stage: 'attempts-exhausted', retryable: false })
    expect(secureStore.__prompts()).toBe(0)
    expect(secureStore.__get('mnemonic')).toBe(MNEMONIC)
  })

  it('sweeps the plaintext on the next launch if it crashed after committing', async () => {
    await seedLegacyInstall()
    await migrateLegacySecrets()
    // Simulate the crash window: committed sentinel, legacy item still present.
    secureStore.__seed('mnemonic', MNEMONIC)

    __resetForTests()
    const result = await migrateLegacySecrets()

    expect(result).toEqual({ outcome: 'not-needed' })
    expect(secureStore.__has('mnemonic')).toBe(false)
  })

  it('XR-111: reports incomplete cleanup when the legacy plaintext survives its own deletion', async () => {
    await seedLegacyInstall({ recoveredKey: WIF })
    // iOS's delete discards every OSStatus and never throws: simulate the
    // documented silent-no-op case by having the read keep answering with
    // the old value even though the delete call itself resolved normally.
    secureStore.__overrideRead('mnemonic', MNEMONIC)

    const result = await migrateLegacySecrets()

    expect(result).toMatchObject({
      outcome: 'migrated',
      names: ['mnemonic', 'recoveredKey'],
      legacyCleanupPending: true
    })
    // The migration itself still fully succeeded — only the legacy sweep did
    // not — so the user must still have a working, envelope-backed wallet.
    expect(await getSecret('mnemonic')).toBe(MNEMONIC)
    expect(await getSecret('recoveredKey')).toBe(WIF)
  })

  it('is a no-op on a fresh install and never prompts', async () => {
    const result = await migrateLegacySecrets()
    expect(result).toEqual({ outcome: 'not-needed' })
    expect(await readSentinel()).toBeNull()
    expect(secureStore.__prompts()).toBe(0)
  })

  it('is idempotent and prompt-free on an already-migrated install', async () => {
    await seedLegacyInstall()
    await migrateLegacySecrets()

    __resetForTests()
    secureStore.__clearPrompts()
    expect(await migrateLegacySecrets()).toEqual({ outcome: 'not-needed' })
    expect(secureStore.__prompts()).toBe(0)
  })

  it('migrates a recovered-key-only wallet', async () => {
    await seedLegacyInstall({ mnemonic: '', recoveredKey: WIF })

    expect(await migrateLegacySecrets()).toEqual({ outcome: 'migrated', names: ['recoveredKey'] })
    expect(await getSecret('recoveredKey')).toBe(WIF)
  })

  it('costs one ceremony to migrate and one per launch thereafter', async () => {
    await seedLegacyInstall({ recoveredKey: WIF })
    await migrateLegacySecrets()
    expect(secureStore.__prompts()).toBe(1) // the provisioning write

    __resetForTests()
    secureStore.__clearPrompts()
    await migrateLegacySecrets()
    expect((await unlockKek()).status).toBe('unlocked')
    expect(await getSecret('mnemonic')).toBe(MNEMONIC)
    expect(await getSecret('recoveredKey')).toBe(WIF)
    expect(secureStore.__prompts()).toBe(1)
  })
})

describe('migration refuses an existing envelope identity without its sentinel', () => {
  beforeEach(async () => {
    secureStore.__reset()
    localAuth.__reset()
    __resetForTests()
    await AsyncStorage.clear()
    ;(global as any).__DEV__ = false
  })

  it.each(['envV1.mnemonic', KEK_AUTH_KEY])(
    'preserves legacy state when identity probe %s is unreadable',
    async unreadable => {
      await seedLegacyInstall()
      const originalRead = secureStore.getItemAsync.getMockImplementation()!
      secureStore.getItemAsync.mockImplementation(async (key, options) => {
        if (key === unreadable) throw new Error('keychain unavailable')
        return originalRead(key, options)
      })
      try {
        expect(await migrateLegacySecrets()).toEqual({ outcome: 'failed', stage: 'existing-identity', retryable: true })
        expect(secureStore.__get('mnemonic')).toBe(MNEMONIC)
        expect(secureStore.setItemAsync).not.toHaveBeenCalled()
        expect(secureStore.deleteItemAsync).not.toHaveBeenCalled()
      } finally {
        secureStore.getItemAsync.mockImplementation(originalRead)
      }
    }
  )

  it.each(['missing', 'missing-envelope', 'corrupt', 'unreadable'])(
    'preserves the existing KEK and envelope for a %s sentinel',
    async kind => {
      await seedLegacyInstall()
      await migrateLegacySecrets()
      const originalKey = secureStore.__get(KEK_AUTH_KEY, { service: 'bsvb.kek.v1', auth: true })
      const originalBlob = secureStore.__get('envV1.mnemonic', { service: ENV_SERVICE })
      __resetForTests()
      if (kind === 'missing' || kind === 'missing-envelope') {
        await secureStore.deleteItemAsync(SENTINEL_KEY, envOptions)
        if (kind === 'missing-envelope') await secureStore.deleteItemAsync('envV1.mnemonic', envOptions)
      } else if (kind === 'corrupt') secureStore.__seed(SENTINEL_KEY, '{', { service: ENV_SERVICE })
      else {
        const originalRead = secureStore.getItemAsync.getMockImplementation()!
        secureStore.getItemAsync.mockImplementationOnce(async () => {
          throw new Error('temporarily unavailable')
        })
        // The one-shot failure must not replace the normal storage implementation.
        expect(originalRead).toBeDefined()
      }
      secureStore.__seed('mnemonic', 'attacker-chosen wallet')
      secureStore.deleteItemAsync.mockClear()
      const result = await migrateLegacySecrets()
      expect(result.outcome).toBe('failed')
      expect(secureStore.__get(KEK_AUTH_KEY, { service: 'bsvb.kek.v1', auth: true })).toBe(originalKey)
      expect(secureStore.__get('envV1.mnemonic', { service: ENV_SERVICE })).toBe(
        kind === 'missing-envelope' ? undefined : originalBlob
      )
      expect(secureStore.deleteItemAsync).not.toHaveBeenCalledWith(KEK_AUTH_KEY, expect.anything())
      expect(await getSecret('mnemonic')).toBeNull()
    }
  )
})
