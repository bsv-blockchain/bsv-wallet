/**
 * Wallet profiles in WalletContext: adding and switching profiles rebuilds the
 * wallet from that profile's own keys, and a profile awaiting restore replays
 * its backup on the build that activates it — and only then.
 */
// WalletContext reaches the vault store (and, through LocalStorageProvider,
// the secrets policy), both of which import a native Expo module at load time.
// Same two stubs every other suite that imports the provider installs — see
// __tests__/ui/universalSend.test.tsx.
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import React from 'react'
import { act, render } from '@testing-library/react-native'
import { PrivateKey } from '@bsv/sdk'
import { WalletContextProvider, useWallet } from '../../core/context/WalletContext'
import { configureToolbox, resetToolboxConfig } from '../../core/toolboxConfig'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  __resetProfilesForTests,
  getActiveProfileIndex,
  getProfilesState,
  PROFILES_STORAGE_KEY
} from '../../core/profiles/profileStore'

// The provider now requires the host to have stated its endpoints — see
// core/toolboxConfig.ts. A backup URL keeps the restore-on-import path live;
// without one, restoreOnImport is never reached.
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
const mockRestore = jest.fn()
const mockPostRestoreSetup = jest.fn(() => {
  throw new Error('Reached post-restore setup')
})
const mockDestroy = jest.fn(async () => {})
const mockManagers: any[] = []
let mockBuildMode: 'bypass' | 'real' = 'bypass'
let mockSecretsReady = false
// Stateful, unlike the rest of this file's mocks — XR-017 needs to observe a failed
// restore's database actually leaving the registry, not just a fixed answer.
let mockRegisteredDbs: string[] = []
const mockRegisterDb = jest.fn(async (_keySuffix: string, _chain: string, filename: string) => {
  if (!mockRegisteredDbs.includes(filename)) mockRegisteredDbs.push(filename)
})
const mockUnregisterDb = jest.fn(async (_keySuffix: string, _chain: string, filename: string) => {
  mockRegisteredDbs = mockRegisteredDbs.filter(f => f !== filename)
})
const mockDeleteDatabaseAsync = jest.fn(async (_name: string) => {})

jest.mock('../../core/context/LocalStorageProvider', () => ({
  useLocalStorage: () => ({
    getMnemonic: mockGetMnemonic,
    getRecoveredKey: mockGetRecoveredKey,
    getItem: mockGetItem,
    setItem: mockSetItem,
    deleteAllWalletKeys: jest.fn(),
    secretsReady: mockSecretsReady
  })
}))
jest.mock(
  '@bsv/btms-permission-module',
  () => ({
    createBtmsModule: () => mockPostRestoreSetup()
  }),
  { virtual: true }
)
jest.mock('../../core/backup/restoreOnImport', () => ({
  restoreOnImport: (...args: unknown[]) => mockRestore(...args)
}))
const mockRecover = jest.fn((_mnemonic: string, _passphrase?: string, profileIndex = 0) => {
  const { PrivateKey } = jest.requireActual('@bsv/sdk')
  const key = new PrivateKey(21 + profileIndex)
  return { privilegedKey: key, primaryKey: key.toArray('be', 32), identityKey: key.toPublicKey().toString() }
})
jest.mock('../../core/mnemonicWallet', () => ({
  ...jest.requireActual('../../core/mnemonicWallet'),
  recoverMnemonicWallet: (...args: [string, string?, number?]) => mockRecover(...args)
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
jest.mock('../../core/walletDbRegistry', () => ({
  getRegisteredDbs: async () => mockRegisteredDbs,
  registerDb: (...args: [string, string, string]) => mockRegisterDb(...args),
  unregisterDb: (...args: [string, string, string]) => mockUnregisterDb(...args),
  // Real logic (pure — picks by embedded timestamp): a stateful registry needs it to
  // actually distinguish the failed db from a freshly created one, not just echo a fixed
  // name back.
  selectLatestDb: (names: string[]) => jest.requireActual('../../core/walletDbRegistry').selectLatestDb(names)
}))
// WalletContext's own restore-failure cleanup calls this directly (see XR-017); the global
// moduleNameMapper's expo-sqlite stub throws unconditionally, so this file needs its own to
// observe the call.
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('expo-sqlite is native: inject a database handle in tests')
  },
  deleteDatabaseAsync: (...args: [string]) => mockDeleteDatabaseAsync(...args)
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
  mockSecretsReady = false
  mockBuildMode = 'bypass'
  mockManagers.length = 0
  mockRegisteredDbs = ['restore-test.db']
  mockGetMnemonic.mockResolvedValue(null)
  mockGetRecoveredKey.mockResolvedValue(null)
  mockRestore.mockRejectedValue(new Error('backup unavailable'))
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
  // The global developer watchdog is unrelated to these build tests.
  ;(globalThis as any).__jsStallWatchdog = true
})

afterEach(async () => {
  await act(async () => renderer?.unmount())
  jest.restoreAllMocks()
})

beforeEach(async () => {
  __resetProfilesForTests()
  await AsyncStorage.clear()
  mockRecover.mockClear()
})

/** Profile indices derived since the last clear. A build of profile n also
 * derives profile 0 to check the store belongs to this seed. */
const derivedIndices = () => mockRecover.mock.calls.map(c => c[2] ?? 0)
const lastProfileIndexBuilt = () => mockRecover.mock.calls.at(-1)?.[2]

async function renderBuilt() {
  mockSecretsReady = true
  mockGetMnemonic.mockResolvedValue('synthetic test key')
  await renderProvider()
  await act(async () => {})
  expect(wallet.walletBuilt).toBe(true)
}

it('builds profile 0 by default and marks profiles supported', async () => {
  await renderBuilt()
  expect(lastProfileIndexBuilt()).toBe(0)
  expect(wallet.profilesSupported).toBe(true)
  expect(wallet.activeProfile).toBe(0)
  expect(wallet.profiles).toHaveLength(1)
})

it('addProfile appends profile 1, switches to it and builds its keys; switching back rebuilds profile 0', async () => {
  await renderBuilt()
  mockRecover.mockClear()
  await act(async () => {
    await wallet.addProfile()
  })
  expect(wallet.activeProfile).toBe(1)
  expect(getActiveProfileIndex()).toBe(1)
  expect(wallet.profiles.map(p => p.index)).toEqual([0, 1])
  expect(derivedIndices()).toContain(1)
  expect(wallet.switchingProfile).toBe(false)
  expect(wallet.walletBuilt).toBe(true)
  expect(JSON.parse((await AsyncStorage.getItem(PROFILES_STORAGE_KEY))!).active).toBe(1)

  mockRecover.mockClear()
  await act(async () => {
    await wallet.switchProfile(0)
  })
  expect(wallet.activeProfile).toBe(0)
  expect(derivedIndices()).toEqual([0])
  expect(wallet.walletBuilt).toBe(true)
})

it('a second switch while one is running is ignored', async () => {
  await renderBuilt()
  await act(async () => {
    await Promise.all([wallet.addProfile(), wallet.addProfile()])
  })
  expect(wallet.profiles).toHaveLength(2)
  expect(wallet.activeProfile).toBe(1)
  expect(wallet.walletBuilt).toBe(true)
})

it('a cold start on a stored profile builds that profile on its own network', async () => {
  await AsyncStorage.setItem(
    PROFILES_STORAGE_KEY,
    JSON.stringify({
      active: 1,
      profiles: [
        { index: 0, network: 'main' },
        { index: 1, network: 'test' }
      ]
    })
  )
  await AsyncStorage.setItem('wallet_user_avatar_icon__p1', 'ionicons/leaf')
  await renderBuilt()
  expect(lastProfileIndexBuilt()).toBe(1)
  expect(wallet.selectedNetwork).toBe('test')
  const { getUserAvatarIcon } = require('../../core/userAvatar')
  expect(getUserAvatarIcon()).toEqual({ family: 'ionicons', name: 'leaf' })
})

describe('a removed profile (tombstone)', () => {
  const stored = async (active: number) =>
    AsyncStorage.setItem(
      PROFILES_STORAGE_KEY,
      JSON.stringify({
        active,
        profiles: [
          { index: 0, network: 'main' },
          { index: 1, network: 'main', identityKey: '02ab', deleted: true },
          { index: 2, network: 'test' }
        ]
      })
    )

  it('switchProfile refuses it: nothing is torn down, the active profile stays', async () => {
    await stored(2)
    await renderBuilt()
    expect(lastProfileIndexBuilt()).toBe(2)
    mockRecover.mockClear()
    await act(async () => {
      await wallet.switchProfile(1)
    })
    expect(wallet.activeProfile).toBe(2)
    expect(getActiveProfileIndex()).toBe(2)
    expect(mockRecover).not.toHaveBeenCalled()
    expect(wallet.walletBuilt).toBe(true)
    expect(wallet.switchingProfile).toBe(false)
    expect(JSON.parse((await AsyncStorage.getItem(PROFILES_STORAGE_KEY))!).active).toBe(2)
    expect(mockDestroy).not.toHaveBeenCalled()
  })

  it('a live profile past the tombstone is still reachable', async () => {
    await stored(0)
    await renderBuilt()
    mockRecover.mockClear()
    await act(async () => {
      await wallet.switchProfile(2)
    })
    expect(wallet.activeProfile).toBe(2)
    expect(derivedIndices()).toContain(2)
    expect(wallet.selectedNetwork).toBe('test')
  })

  it('a stored active pointer on a tombstone starts on the nearest live profile', async () => {
    await stored(1)
    await renderBuilt()
    expect(lastProfileIndexBuilt()).toBe(0)
    expect(wallet.activeProfile).toBe(0)
  })

  it('addProfile takes the next slot after the tombstone, never the removed index', async () => {
    await stored(0)
    await renderBuilt()
    // [0, 1x, 2] is already three long, so the next profile is 3.
    mockRecover.mockClear()
    await act(async () => {
      await wallet.addProfile()
    })
    expect(wallet.profiles.map(p => p.index)).toEqual([0, 1, 2, 3])
    expect(wallet.profiles[1].deleted).toBe(true)
    expect(wallet.activeProfile).toBe(3)
    expect(derivedIndices()).toContain(3)
  })
})

it("switchNetwork changes only the active profile's network", async () => {
  await renderBuilt()
  await act(async () => {
    await wallet.addProfile()
  })
  await act(async () => {
    await wallet.switchNetwork('test')
  })
  await act(async () => {})
  expect(getProfilesState().profiles.map(p => p.network)).toEqual(['main', 'test'])
  await act(async () => {
    await wallet.switchProfile(0)
  })
  expect(wallet.selectedNetwork).toBe('main')
})

it('replays the backup only on the build that activates a profile awaiting restore', async () => {
  await renderBuilt()
  mockBuildMode = 'real'
  // Rejecting ends the real build right at the restore, which is all this needs.
  // Every later build (the fallback to profile 0) runs in bypass mode.
  mockRestore.mockImplementation(async () => {
    mockBuildMode = 'bypass'
    throw new Error('backup unavailable')
  })
  mockRegisteredDbs = []
  await act(async () => {
    await wallet.addProfile()
  })
  expect(mockRestore).toHaveBeenCalledTimes(1)
  expect(mockRestore.mock.calls[0][0]).toMatchObject({ primaryKey: new PrivateKey(22).toArray('be', 32) })
  // A failed restore leaves the profile waiting, so its next activation retries,
  // and the switch falls back to the profile the user came from — whose own
  // build replays nothing.
  expect(getProfilesState().profiles[1].needsRestore).toBe(true)
  expect(wallet.activeProfile).toBe(0)
  expect(lastProfileIndexBuilt()).toBe(0)
  expect(wallet.switchingProfile).toBe(false)
  expect(wallet.walletBuilt).toBe(true)
  expect(mockRestore).toHaveBeenCalledTimes(1)
})

it('a rebuild after a failed build still runs instead of waiting out its timeout', async () => {
  await renderBuilt()
  mockBuildMode = 'real'
  mockRestore.mockRejectedValue(new Error('backup unavailable'))
  mockRegisteredDbs = []
  // Two acts, as in walletBuildRestore.test: rebuildWallet waits for the
  // auto-build effect, which act only flushes between them.
  let rebuilding!: Promise<void>
  await act(async () => {
    rebuilding = wallet.rebuildWallet({ restoreFromBackup: true })
  })
  await act(async () => {
    await rebuilding
  })
  expect(mockRestore).toHaveBeenCalledTimes(1)
  expect(wallet.walletBuilt).toBe(false)

  // Nothing the auto-build effect watches changes on this rebuild.
  mockBuildMode = 'bypass'
  await act(async () => {
    rebuilding = wallet.rebuildWallet()
  })
  await act(async () => {
    await rebuilding
  })
  expect(wallet.walletBuilt).toBe(true)
})

it('a recovered-key wallet has no profiles', async () => {
  await renderProvider()
  await act(async () => wallet.buildWalletFromRecoveredKey(new PrivateKey(21).toWif()))
  expect(wallet.walletBuilt).toBe(true)
  expect(wallet.profilesSupported).toBe(false)
  await act(async () => {
    await wallet.addProfile()
  })
  expect(wallet.profiles).toHaveLength(1)
})
