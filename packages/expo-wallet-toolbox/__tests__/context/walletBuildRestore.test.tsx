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
const mockDeleteDatabaseAsync = jest.fn(async () => {})

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
jest.mock('../../core/mnemonicWallet', () => ({
  recoverMnemonicWallet: () => {
    const { PrivateKey } = jest.requireActual('@bsv/sdk')
    const key = new PrivateKey(21)
    return { rootKey: key, primaryKey: key.toArray('be', 32) }
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

it('preserves a rebuild restore request through automatic mnemonic build and leaves failure retryable', async () => {
  await renderProvider()
  await act(async () => wallet.buildWalletFromMnemonic('synthetic test key'))
  expect(wallet.walletBuilt).toBe(true)

  mockBuildMode = 'real'
  mockGetMnemonic.mockResolvedValue('synthetic test key')
  mockGetRecoveredKey.mockResolvedValue(new PrivateKey(22).toWif())
  mockSecretsReady = true
  let rebuilding!: Promise<void>
  await act(async () => {
    rebuilding = wallet.rebuildWallet({ restoreFromBackup: true })
  })
  await act(async () => {
    await rebuilding
  })

  expect(mockRestore).toHaveBeenCalledTimes(1)
  expect(wallet.getBackupRestore()).toMatchObject({ phase: 'failed', error: 'backup unavailable' })
  expect(wallet.walletBuilt).toBe(false)
  expect(wallet.walletBuilding).toBe(false)
  expect(mockManagers.at(-1).authenticated).toBe(false)
  expect(mockDestroy).toHaveBeenCalledTimes(1)
  expect(mockGetRecoveredKey).not.toHaveBeenCalled()

  await act(async () => wallet.buildWalletFromMnemonic('synthetic test key', { restoreFromBackup: true }))
  expect(mockRestore).toHaveBeenCalledTimes(2)
  expect(wallet.walletBuilt).toBe(false)
  expect(mockDestroy).toHaveBeenCalledTimes(2)
})

it('preserves a rebuild restore request when automatic build falls back to a recovered key', async () => {
  await renderProvider()
  await act(async () => wallet.buildWalletFromRecoveredKey(new PrivateKey(21).toWif()))
  expect(wallet.walletBuilt).toBe(true)

  mockBuildMode = 'real'
  mockGetRecoveredKey.mockResolvedValue(new PrivateKey(21).toWif())
  mockSecretsReady = true
  let rebuilding!: Promise<void>
  await act(async () => {
    rebuilding = wallet.rebuildWallet({ restoreFromBackup: true })
  })
  await act(async () => {
    await rebuilding
  })

  expect(mockRestore).toHaveBeenCalledTimes(1)
  expect(wallet.getBackupRestore().phase).toBe('failed')
  expect(wallet.walletBuilt).toBe(false)
  expect(mockManagers.at(-1).authenticated).toBe(false)
})

it.each(['mnemonic', 'recovered key'] as const)(
  'XR-017: allows explicit restore=false after a failed %s restore, without reusing the tainted database',
  async kind => {
    await renderProvider()
    mockBuildMode = 'real'
    // A genuinely fresh identity: knownDbs.length === 0, so this very attempt's db-selection
    // block is what creates the database restoreOnImport then partially replays into and
    // fails against. This is the only case the cleanup below may touch — see the review
    // follow-up test below for the "database predates this attempt" case it must NOT touch.
    mockRegisteredDbs = []
    let clock = 1700000000000
    jest.spyOn(Date, 'now').mockImplementation(() => clock)

    const build = (restoreFromBackup: boolean) =>
      kind === 'mnemonic'
        ? wallet.buildWalletFromMnemonic('synthetic test key', { restoreFromBackup })
        : wallet.buildWalletFromRecoveredKey(new PrivateKey(21).toWif(), { restoreFromBackup })

    await act(async () => build(true))
    expect(mockRestore).toHaveBeenCalledTimes(1)
    expect(wallet.walletBuilt).toBe(false)
    expect(mockPostRestoreSetup).not.toHaveBeenCalled()
    // The name this attempt's own db-selection block generated (not a hardcoded fixture) —
    // it must have been registered exactly once, by the "fresh user" branch.
    expect(mockRegisterDb).toHaveBeenCalledTimes(1)
    const firstDb = mockRegisterDb.mock.calls[0][2]
    // XR-017: the freshly-created-but-partially-replayed database must not survive the
    // failure, or a later build that skips another replay (recoverWallet's "skip", or this
    // very restore:false call) would reselect it via selectLatestDb and publish it as a
    // working wallet.
    expect(mockUnregisterDb).toHaveBeenCalledWith(expect.any(String), expect.any(String), firstDb)
    expect(mockDeleteDatabaseAsync).toHaveBeenCalledWith(firstDb)
    expect(mockRegisteredDbs).not.toContain(firstDb)

    clock += 1000 // distinct timestamp so the retry's fresh db can't collide with the first
    await act(async () => build(false))
    expect(mockRestore).toHaveBeenCalledTimes(1)
    // The build reaches setup after the restore branch, without another replay.
    expect(mockPostRestoreSetup).toHaveBeenCalledTimes(1)
    // A genuinely different (freshly created) database, not the failed one reselected.
    expect(mockRegisteredDbs).not.toContain(firstDb)
    expect(mockRegisteredDbs).toHaveLength(1)
  }
)

it('XR-017: review follow-up — never deletes/unregisters a database that predates this restore attempt', async () => {
  await renderProvider()
  mockBuildMode = 'real'
  // Simulates "recover over an already-onboarded wallet" — core/recovery/restoreWallet.ts's
  // rebuildWallet({restoreFromBackup:true}) path, taken whenever isWalletBuilt() is already
  // true (e.g. the user re-enters the SAME mnemonic that already built their working
  // wallet; recoverWallet.ts's confirmReplace gate does not check whether the new secret
  // differs from the one already active). The registry already names this identity's real,
  // live database BEFORE this attempt starts: knownDbs.length is 1, so the db-selection
  // block never takes the "create a fresh db" branch — this attempt did not create the
  // file selectLatestDb hands it.
  const preExisting = 'wallet-aaaaaaaa-mainnet-1700000000.db'
  mockRegisteredDbs = [preExisting]

  await act(async () => wallet.buildWalletFromMnemonic('synthetic test key', { restoreFromBackup: true }))

  expect(mockRestore).toHaveBeenCalledTimes(1)
  expect(wallet.walletBuilt).toBe(false)
  // The database predates this attempt — it may be the user's real, already-transacting
  // wallet with seed-unrecoverable change-output/BRC-29 metadata — so a failed restore's
  // cleanup must leave it completely alone.
  expect(mockUnregisterDb).not.toHaveBeenCalled()
  expect(mockDeleteDatabaseAsync).not.toHaveBeenCalled()
  expect(mockRegisteredDbs).toEqual([preExisting])
})

it('getWalletBuilt() is a ref-backed read that reflects walletBuilt after a build', async () => {
  await renderProvider()
  expect(wallet.getWalletBuilt()).toBe(false)

  await act(async () => wallet.buildWalletFromMnemonic('synthetic test key'))

  expect(wallet.walletBuilt).toBe(true)
  expect(wallet.getWalletBuilt()).toBe(true)
})
