import React from 'react'
import { act, render } from '@testing-library/react-native'
import { PrivateKey } from '@bsv/sdk'
import { WalletContextProvider, useWallet } from '../../core/context/WalletContext'

const mockGetMnemonic = jest.fn<Promise<string | null>, []>()
const mockGetRecoveredKey = jest.fn<Promise<string | null>, []>()
const mockGetItem = jest.fn(async () => null)
const mockSetItem = jest.fn(async () => {})
const mockRestore = jest.fn()
const mockPostRestoreSetup = jest.fn(() => { throw new Error('Reached post-restore setup') })
const mockDestroy = jest.fn(async () => {})
const mockManagers: any[] = []
let mockBuildMode: 'bypass' | 'real' = 'bypass'
let mockSecretsReady = false

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
jest.mock('@bsv/btms-permission-module', () => ({
  createBtmsModule: () => mockPostRestoreSetup()
}), { virtual: true })
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
jest.mock('../../core/services/vault/ceremonyHost', () => ({ VAULT_RETENTION_MS: 1000, ceremony: {} }))
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
  getRegisteredDbs: async () => ['restore-test.db'],
  selectLatestDb: () => 'restore-test.db'
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
        super(originator, (...args: any[]) => mockBuildMode === 'bypass' ? Promise.resolve({}) : builder(...args))
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
  renderer = render(<WalletContextProvider><ObserveWallet /></WalletContextProvider>)
  await act(async () => {})
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSecretsReady = false
  mockBuildMode = 'bypass'
  mockManagers.length = 0
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
  await act(async () => { rebuilding = wallet.rebuildWallet({ restoreFromBackup: true }) })
  await act(async () => { await rebuilding })

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
  await act(async () => { rebuilding = wallet.rebuildWallet({ restoreFromBackup: true }) })
  await act(async () => { await rebuilding })

  expect(mockRestore).toHaveBeenCalledTimes(1)
  expect(wallet.getBackupRestore().phase).toBe('failed')
  expect(wallet.walletBuilt).toBe(false)
  expect(mockManagers.at(-1).authenticated).toBe(false)
})


it.each(['mnemonic', 'recovered key'] as const)('allows explicit restore=false after a failed %s restore', async kind => {
  await renderProvider()
  mockBuildMode = 'real'
  const build = (restoreFromBackup: boolean) => kind === 'mnemonic'
    ? wallet.buildWalletFromMnemonic('synthetic test key', { restoreFromBackup })
    : wallet.buildWalletFromRecoveredKey(new PrivateKey(21).toWif(), { restoreFromBackup })

  await act(async () => build(true))
  expect(mockRestore).toHaveBeenCalledTimes(1)
  expect(wallet.walletBuilt).toBe(false)
  expect(mockPostRestoreSetup).not.toHaveBeenCalled()

  await act(async () => build(false))
  expect(mockRestore).toHaveBeenCalledTimes(1)
  // The build reaches setup after the restore branch, without another replay.
  expect(mockPostRestoreSetup).toHaveBeenCalledTimes(1)
})
