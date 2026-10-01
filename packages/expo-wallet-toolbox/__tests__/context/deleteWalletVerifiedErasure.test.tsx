/**
 * XR-107 (WalletContext half): "Delete Wallet" is WalletContext.tsx's
 * logout(), which used to `await deleteAllWalletKeys()` and then
 * unconditionally clear the per-wallet backup attestation and navigate away
 * — regardless of whether the secrets layer actually verified every legacy
 * plaintext item gone. A persistent SecureStore delete failure (store.ts's
 * own sweepLegacyKeys() already models and reports this) was silently
 * swallowed: the UI still reported success and navigated to the clean/
 * onboarding screen while a legacy mnemonic/recoveredKey/password survived.
 *
 * This drives the REAL WalletContextProvider (same heavy-mock harness as
 * __tests__/context/walletBuildRestore.test.tsx) through a real logout()
 * call, with deleteAllWalletKeys() controlled per test, and asserts the
 * fail-closed contract: a verified-incomplete erasure must not clear the
 * backup attestation or navigate away, and must be reported back to the
 * caller so the UI can show an error and let the user retry — not silently
 * behave as if the wallet were fully gone.
 */
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('expo-router', () => ({
  router: { dismissAll: jest.fn(), replace: jest.fn() }
}))

import React from 'react'
import { act, render } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { PrivateKey } from '@bsv/sdk'
import { router as mockRouter } from 'expo-router'
import { WalletContextProvider, useWallet } from '../../core/context/WalletContext'
import { configureToolbox, resetToolboxConfig } from '../../core/toolboxConfig'
import { ATTEST_KEY_PREFIX } from '../../core/services/vault/backupAttestation'

beforeEach(() => {
  configureToolbox({ backupUrl: 'https://backup.example.com' })
})
afterEach(() => {
  resetToolboxConfig()
})

const mockGetMnemonic = jest.fn<Promise<string | null>, []>()
const mockGetRecoveredKey = jest.fn<Promise<string | null>, []>()
const mockGetItem = jest.fn(async () => null)
const mockSetItem = jest.fn(async () => {})
const mockDeleteAllWalletKeys = jest.fn<Promise<boolean>, []>()
const mockDestroy = jest.fn(async () => {})
const mockManagers: any[] = []
let mockBuildMode: 'bypass' | 'real' = 'bypass'

jest.mock('../../core/context/LocalStorageProvider', () => ({
  useLocalStorage: () => ({
    getMnemonic: mockGetMnemonic,
    getRecoveredKey: mockGetRecoveredKey,
    getItem: mockGetItem,
    setItem: mockSetItem,
    deleteAllWalletKeys: mockDeleteAllWalletKeys,
    secretsReady: false
  })
}))
jest.mock(
  '@bsv/btms-permission-module',
  () => ({ createBtmsModule: () => ({}) }),
  { virtual: true }
)
jest.mock('../../core/backup/restoreOnImport', () => ({
  restoreOnImport: jest.fn(async () => {})
}))
jest.mock('../../core/mnemonicWallet', () => ({
  recoverMnemonicWallet: () => {
    const { PrivateKey: RealPrivateKey } = jest.requireActual('@bsv/sdk')
    const key = new RealPrivateKey(21)
    return { privilegedKey: key, primaryKey: key.toArray('be', 32) }
  }
}))
jest.mock('../../core/services/exchangeRate', () => ({ getExchangeRate: async () => 50 }))
jest.mock('../../core/services/vault/driver', () => ({ getVaultDriver: () => null }))
jest.mock('../../core/services/vault/ceremonyHost', () => ({
  VAULT_RETENTION_MS: 1000,
  ceremony: { cancel: () => {}, subscribe: () => () => {}, getState: () => undefined }
}))
jest.mock('../../core/headers/fs', () => ({ expoHeaderFs: {} }))
jest.mock('../../core/net/online', () => ({
  getOnline: async () => false,
  subscribeOnline: () => () => {}
}))
jest.mock('../../core/services/walletServiceConfig', () => ({
  chaintracksUrlFor: () => 'https://chaintracks.invalid',
  createServices: () => ({
    services: {
      postBeefServices: { add: jest.fn(), remove: jest.fn() },
      getMerklePathServices: { add: jest.fn(), remove: jest.fn() }
    },
    serviceOptions: {}
  })
}))
const mockPurgeIdentityDbFiles = jest.fn(async (_keySuffix: string, _deleteFile: unknown) => {})
jest.mock('../../core/walletDbRegistry', () => ({
  purgeRegisteredDbFiles: jest.fn(async () => {}),
  purgeIdentityDbFiles: (...args: [string, unknown]) => mockPurgeIdentityDbFiles(...args),
  getRegisteredDbs: async () => ['delete-wallet-test.db'],
  registerDb: jest.fn(async () => {}),
  unregisterDb: jest.fn(async () => {}),
  selectLatestDb: (names: string[]) => jest.requireActual('../../core/walletDbRegistry').selectLatestDb(names)
}))
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('expo-sqlite is native: inject a database handle in tests')
  },
  deleteDatabaseAsync: jest.fn(async () => {})
}))
jest.mock('../../core/storage', () => ({
  StorageExpoSQLite: class {
    db = {}
    setServices() {}
    setVaultAdminOriginator() {}
    async migrate() {}
    destroy = mockDestroy
  }
}))
jest.mock('@bsv/wallet-toolbox-mobile', () => {
  const actual = jest.requireActual('@bsv/wallet-toolbox-mobile')
  return {
    ...actual,
    Wallet: class {
      settingsManager = {}
    },
    WalletSigner: class {},
    WalletStorageManager: class {},
    SimpleWalletManager: class extends actual.SimpleWalletManager {
      constructor(originator: string, builder: (...args: any[]) => Promise<any>) {
        super(originator, (...args: any[]) => (mockBuildMode === 'bypass' ? Promise.resolve({}) : builder(...args)))
        mockManagers.push(this)
      }
    }
  }
})

let wallet: ReturnType<typeof useWallet>
function ObserveWallet() {
  wallet = useWallet()
  return null
}
let renderer: ReturnType<typeof render>

async function renderProvider() {
  renderer = render(
    <WalletContextProvider>
      <ObserveWallet />
    </WalletContextProvider>
  )
  await act(async () => {})
}

beforeEach(() => {
  jest.clearAllMocks()
  mockBuildMode = 'bypass'
  mockManagers.length = 0
  mockGetMnemonic.mockResolvedValue(null)
  mockGetRecoveredKey.mockResolvedValue(null)
  mockDeleteAllWalletKeys.mockResolvedValue(true)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
  ;(globalThis as any).__jsStallWatchdog = true
})

afterEach(async () => {
  await act(async () => renderer?.unmount())
  jest.restoreAllMocks()
})

describe('XR-107: Delete Wallet only reports success after verified secret erasure', () => {
  it('navigates away and clears the backup attestation once deleteAllWalletKeys verifies erasure', async () => {
    await AsyncStorage.setItem(`${ATTEST_KEY_PREFIX}deadbeef`, JSON.stringify({ v: 1, medium: 'phrase', at: 1 }))
    await renderProvider()
    await act(async () => wallet.buildWalletFromMnemonic('synthetic test key'))
    expect(wallet.walletBuilt).toBe(true)

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await wallet.logout()
    })

    expect(outcome).toBe(true)
    expect(mockDeleteAllWalletKeys).toHaveBeenCalledTimes(1)
    expect(mockRouter.dismissAll).toHaveBeenCalledTimes(1)
    expect(mockRouter.replace).toHaveBeenCalledWith('/')
    // The attestation this wallet left behind must not survive a verified wipe.
    expect(await AsyncStorage.getItem(`${ATTEST_KEY_PREFIX}deadbeef`)).toBeNull()
  })

  it('reports failure, does NOT navigate away, and does NOT clear the backup attestation when a legacy secret survives deletion', async () => {
    await AsyncStorage.setItem(`${ATTEST_KEY_PREFIX}deadbeef`, JSON.stringify({ v: 1, medium: 'phrase', at: 1 }))
    mockDeleteAllWalletKeys.mockResolvedValue(false)
    await renderProvider()
    await act(async () => wallet.buildWalletFromMnemonic('synthetic test key'))
    expect(wallet.walletBuilt).toBe(true)

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await wallet.logout()
    })

    // The UI must be told this did NOT complete, so it can show an error and
    // let the user retry, instead of silently reporting success.
    expect(outcome).toBe(false)
    expect(mockRouter.dismissAll).not.toHaveBeenCalled()
    expect(mockRouter.replace).not.toHaveBeenCalled()
    // A legacy plaintext might still be recoverable — clearing this wallet's
    // "already backed up" record while that is true would be premature, and
    // is exactly the "behaves as if the wallet were fully erased" bug.
    expect(await AsyncStorage.getItem(`${ATTEST_KEY_PREFIX}deadbeef`)).not.toBeNull()

    // Retrying (the same call, once the underlying failure clears) must be
    // able to reach a clean success — this is the "offer retry" half of the
    // fix, not a permanently wedged session.
    mockDeleteAllWalletKeys.mockResolvedValue(true)
    let retryOutcome: boolean | undefined
    await act(async () => {
      retryOutcome = await wallet.logout()
    })
    expect(retryOutcome).toBe(true)
    expect(mockRouter.replace).toHaveBeenCalledWith('/')
    expect(await AsyncStorage.getItem(`${ATTEST_KEY_PREFIX}deadbeef`)).toBeNull()
  })
})

describe('Delete Wallet with several profiles', () => {
  const { PROFILES_STORAGE_KEY, __resetProfilesForTests, getProfilesState, getActiveProfile } =
    jest.requireActual('../../core/profiles/profileStore')
  const KEY_P0 = '02' + '11'.repeat(32)
  const KEY_P1 = '03' + 'ab'.repeat(31) + 'cdef0123'

  beforeEach(async () => {
    __resetProfilesForTests()
    await AsyncStorage.clear()
  })

  it('purges every built profile, sweeps per-profile keys and resets to one profile', async () => {
    await AsyncStorage.setItem(
      PROFILES_STORAGE_KEY,
      JSON.stringify({
        active: 1,
        profiles: [
          { index: 0, network: 'main', identityKey: KEY_P0 },
          { index: 1, network: 'test', identityKey: KEY_P1 },
          // Discovered, never built on this device: nothing to purge, must not throw.
          { index: 2, network: 'main', needsRestore: true }
        ]
      })
    )
    await AsyncStorage.setItem('wallet_user_avatar_icon__p1', 'ionicons/leaf')
    await AsyncStorage.setItem('connections__p2', '[]')
    await AsyncStorage.setItem('walletSettings', '{"currency":"USD"}')
    // Backup opt-outs: profile 0 on the bare key, profile 1 on its scoped one.
    await AsyncStorage.setItem('backupPushEnabled', 'false')
    await AsyncStorage.setItem('backupPushEnabled__p1', 'false')
    // What this device registered for push, per identity: not profile-scoped, so only an explicit sweep takes it.
    await AsyncStorage.setItem('push_registration_v1', JSON.stringify({ [KEY_P0]: 'https://mb.example.org|tok1' }))
    await AsyncStorage.setItem('push_registration_owner_v1', KEY_P0)
    await renderProvider()
    await act(async () => wallet.buildWalletFromMnemonic('synthetic test key'))

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await wallet.logout()
    })

    expect(outcome).toBe(true)
    const purged = mockPurgeIdentityDbFiles.mock.calls.map(c => c[0]).sort()
    expect(purged).toEqual([KEY_P0.slice(-8), KEY_P1.slice(-8)].sort())
    expect(await AsyncStorage.getItem('wallet_user_avatar_icon__p1')).toBeNull()
    expect(await AsyncStorage.getItem('connections__p2')).toBeNull()
    // The next wallet starts with backup ON on every profile: no opt-out outlives the wallet
    // it was made for (profile 0's bare key included).
    expect(await AsyncStorage.getItem('backupPushEnabled__p1')).toBeNull()
    expect(await AsyncStorage.getItem('backupPushEnabled')).toBeNull()
    // The next wallet registers from nothing: no identity key or token of this one is left behind.
    expect(await AsyncStorage.getItem('push_registration_v1')).toBeNull()
    expect(await AsyncStorage.getItem('push_registration_owner_v1')).toBeNull()
    // Shared app settings are not per profile and survive as before.
    expect(await AsyncStorage.getItem('walletSettings')).toBe('{"currency":"USD"}')
    expect(await AsyncStorage.getItem(PROFILES_STORAGE_KEY)).toBeNull()
    expect(getProfilesState().profiles).toHaveLength(1)
    // The departed profile's network must not outlive it: whatever wallet comes
    // next builds on the network its (fresh) profile 0 records.
    await act(async () => {})
    expect(wallet.selectedNetwork).toBe(getActiveProfile().network)
  })
})
