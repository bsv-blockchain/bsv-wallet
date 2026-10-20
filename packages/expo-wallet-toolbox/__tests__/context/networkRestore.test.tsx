/**
 * Per-network restore (bsv-blockchain/bsv-wallet#41), through the real provider
 * build: a wallet that came from a backup replays each network's own backup the
 * first time this device creates that network's database, and only then. A
 * wallet created on this device never asks the backup server anything.
 *
 * The build runs for real up to the monitor, which is stubbed, as in
 * pushProfiles.test.tsx. The database registry is keyed by (identity, chain),
 * so "mainnet has a database, testnet does not" can be expressed.
 */
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import React from 'react'
import { act, render } from '@testing-library/react-native'
import { PrivateKey } from '@bsv/sdk'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { WalletContextProvider, useWallet } from '../../core/context/WalletContext'
import { configureToolbox, resetToolboxConfig } from '../../core/toolboxConfig'
import { deriveProfileKeys, hdFromMnemonic } from '../../core/mnemonicWallet'
import { __resetProfilesForTests, getProfilesState, PROFILES_STORAGE_KEY } from '../../core/profiles/profileStore'
import type { AppChain } from '../../core/config'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const hd = hdFromMnemonic(MNEMONIC)
const P = [0, 1].map(n => deriveProfileKeys(hd, n))
const WIF_KEY = new PrivateKey(41)

let mockSecretsReady = false
const mockGetMnemonic = jest.fn<Promise<string | null>, []>()
const mockGetRecoveredKey = jest.fn<Promise<string | null>, []>()
const mockRestore = jest.fn()
const mockListBackups = jest.fn(async () => [] as unknown[])
/** Registered database names by `${keySuffix}-${chain}`, as walletDbRegistry keeps them. */
let mockDbs: Record<string, string[]> = {}
const mockUnregisterDb = jest.fn(async (s: string, c: string, filename: string) => {
  mockDbs[`${s}-${c}`] = (mockDbs[`${s}-${c}`] ?? []).filter(f => f !== filename)
})
const mockDeleteDatabaseAsync = jest.fn(async (_name: string) => {})

const mockT = (key: string, opts?: Record<string, unknown>) => (opts?.profile ? `${key}:${opts.profile}` : key)
jest.mock('react-i18next', () => ({
  ...jest.requireActual('react-i18next'),
  useTranslation: () => ({ t: mockT, i18n: {} })
}))
jest.mock('../../core/context/LocalStorageProvider', () => ({
  useLocalStorage: () => ({
    getMnemonic: mockGetMnemonic,
    getRecoveredKey: mockGetRecoveredKey,
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    deleteAllWalletKeys: jest.fn(async () => true),
    secretsReady: mockSecretsReady
  })
}))
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), dismissAll: jest.fn(), replace: jest.fn() }
}))
jest.mock('react-native-sse', () => ({ __esModule: true, default: class {} }))
jest.mock('@bsv/btms-permission-module', () => ({ createBtmsModule: () => ({}) }), { virtual: true })
jest.mock('../../core/backup/restoreOnImport', () => ({
  restoreOnImport: (...args: unknown[]) => mockRestore(...args)
}))
// Profile discovery probes the server through this; every probe counts as asking it.
jest.mock('../../core/backup/restore', () => ({
  ...jest.requireActual('../../core/backup/restore'),
  listBackups: (...args: unknown[]) => mockListBackups(...(args as []))
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
  probeOnline: async () => false,
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
jest.mock('../../core/pay/creditInbox', () => ({
  ...jest.requireActual('../../core/pay/creditInbox'),
  creditInboxOnce: async () => ({ accepted: 0, attentionCount: 0, pending: false })
}))
jest.mock('../../core/walletDbRegistry', () => ({
  getRegisteredDbs: async (s: string, c: string) => [...(mockDbs[`${s}-${c}`] ?? [])],
  getAllRegisteredDbs: async () => Object.values(mockDbs).flat(),
  registerDb: async (s: string, c: string, filename: string) => {
    const list = (mockDbs[`${s}-${c}`] ??= [])
    if (!list.includes(filename)) list.push(filename)
  },
  unregisterDb: (...args: [string, string, string]) => mockUnregisterDb(...args),
  purgeIdentityDbFiles: async () => {},
  purgeRegisteredDbFiles: async () => {},
  selectLatestDb: (names: string[]) => jest.requireActual('../../core/walletDbRegistry').selectLatestDb(names)
}))
jest.mock('expo-sqlite', () => ({
  // No legacy (pre-registry) database files exist.
  openDatabaseAsync: async () => {
    throw new Error('expo-sqlite is native')
  },
  deleteDatabaseAsync: (...args: [string]) => mockDeleteDatabaseAsync(...args)
}))
jest.mock('../../core/storage', () => ({
  StorageExpoSQLite: class {
    db = {}
    sqliteDb = { getFirstAsync: async () => null }
    setServices() {}
    setVaultAdminOriginator() {}
    async migrate() {}
    async findOutputBaskets() {
      return []
    }
    async destroy() {}
    async getKeyValue() {
      return undefined
    }
    async setKeyValue() {}
  }
}))
jest.mock('../../core/walletMonitor', () => ({
  boundReviewProvenTxs: () => {},
  configureNewHeaderPolling: () => {},
  createWalletMonitorOptions: () => ({}),
  createWalletMonitor: async () => ({
    _tasks: [],
    _otherTasks: [],
    addTask() {},
    addDefaultTasks() {},
    stopTasks() {},
    startTasks() {},
    fetchSSEEvents: async () => 0
  })
}))
jest.mock('../../core/monitor/MonitorSupervisor', () => ({
  MONITOR_STALL_MS: 120000,
  MonitorSupervisor: class {
    start() {}
    stop() {}
    touch() {}
  }
}))
jest.mock('@bsv/wallet-toolbox-mobile', () => {
  const actual = jest.requireActual('@bsv/wallet-toolbox-mobile')
  return {
    ...actual,
    Wallet: class {
      settingsManager = {}
      async reviewSpendableOutputs() {}
    },
    WalletSigner: class {},
    WalletStorageManager: class {
      async addWalletStorageProvider() {}
      async getAuth() {
        return { userId: 1 }
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
const onToast = jest.fn()

const settle = () => act(async () => new Promise<void>(resolve => setTimeout(resolve, 100)))

async function renderProvider() {
  renderer = render(
    <WalletContextProvider onToast={onToast}>
      <ObserveWallet />
    </WalletContextProvider>
  )
  await act(async () => {})
}

/** The registered databases of `identityKey` on `chain`. */
const dbsOf = (identityKey: string, chain: AppChain) => mockDbs[`${identityKey.slice(-8)}-${chain}`] ?? []

/** Restores that reached the server, as [chain, primary key hex]. */
const restores = () =>
  mockRestore.mock.calls.map(([deps]: any[]) => [deps.chain, Buffer.from(deps.primaryKey).toString('hex')])
const hex = (key: number[]) => Buffer.from(key).toString('hex')

const restoredOk = async (deps: { onProgress?: (c: number, t: number) => void }) => {
  deps.onProgress?.(1, 2)
  deps.onProgress?.(2, 2)
  return { restored: true, chunks: 2, verified: true }
}

/** An import of the seed on `chain`, as the recovery screen drives it. */
async function importSeed(chain: AppChain = 'main') {
  await AsyncStorage.setItem(
    PROFILES_STORAGE_KEY,
    JSON.stringify({ active: 0, profiles: [{ index: 0, network: chain }] })
  )
  await renderProvider()
  if (chain !== 'main') {
    // The first launch configures the stored profile's network; nothing is built yet.
    expect(wallet.selectedNetwork).toBe(chain)
  }
  await act(async () => wallet.buildWalletFromMnemonic(MNEMONIC, { restoreFromBackup: true }))
  await settle()
  expect(wallet.walletBuilt).toBe(true)
  // From here on the app builds by itself, from the stored seed.
  mockSecretsReady = true
  mockGetMnemonic.mockResolvedValue(MNEMONIC)
}

async function switchNetwork(network: AppChain) {
  await act(async () => {
    await wallet.switchNetwork(network)
  })
  await settle()
}

beforeEach(async () => {
  jest.clearAllMocks()
  mockDbs = {}
  mockSecretsReady = false
  mockGetMnemonic.mockResolvedValue(null)
  mockGetRecoveredKey.mockResolvedValue(null)
  mockRestore.mockImplementation(restoredOk)
  mockListBackups.mockResolvedValue([])
  await AsyncStorage.clear()
  __resetProfilesForTests()
  configureToolbox({ backupUrl: 'https://backup.example.com' })
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
  ;(globalThis as any).__jsStallWatchdog = true
})
afterEach(async () => {
  await act(async () => renderer?.unmount())
  resetToolboxConfig()
  jest.restoreAllMocks()
})

describe('an imported wallet switching network', () => {
  it.each([
    ['main', 'test'],
    ['main', 'teratest'],
    ['test', 'main']
  ] as const)('imported on %s, switching to %s restores that network into its new database', async (from, to) => {
    await importSeed(from)
    expect(restores()).toEqual([[from, hex(P[0].primaryKey)]])

    const phases: string[] = []
    mockRestore.mockImplementation(async (deps: any) =>
      restoredOk({ onProgress: (c, t) => (deps.onProgress(c, t), phases.push(wallet.getBackupRestore().phase)) })
    )
    await switchNetwork(to)

    expect(restores()).toEqual([
      [from, hex(P[0].primaryKey)],
      [to, hex(P[0].primaryKey)]
    ])
    expect(phases).toEqual(['restoring', 'restoring'])
    expect(wallet.getBackupRestore()).toMatchObject({ phase: 'restored', chunks: 2 })
    expect(wallet.walletBuilt).toBe(true)
    expect(wallet.selectedNetwork).toBe(to)
    expect(dbsOf(P[0].identityKey, to)).toHaveLength(1)
  })

  it('a network is restored once: switching back and forth replays nothing more', async () => {
    await importSeed('main')
    await switchNetwork('test')
    await switchNetwork('main')
    await switchNetwork('test')
    expect(restores().map(([chain]) => chain)).toEqual(['main', 'test'])
    expect(wallet.walletBuilt).toBe(true)
  })

  it('a network with no backup on the server builds an empty wallet', async () => {
    await importSeed('main')
    mockRestore.mockResolvedValue({ restored: false, chunks: 0, reason: 'no-backup' })
    await switchNetwork('test')

    expect(restores().map(([chain]) => chain)).toEqual(['main', 'test'])
    expect(wallet.getBackupRestore().phase).toBe('no-backup')
    expect(wallet.walletBuilt).toBe(true)
    expect(wallet.selectedNetwork).toBe('test')

    // Asked once: it is not asked again on the next visit.
    await switchNetwork('main')
    await switchNetwork('test')
    expect(restores().map(([chain]) => chain)).toEqual(['main', 'test'])
  })

  it('a failed restore discards the new database, returns to the previous network, says so, and retries next time', async () => {
    await importSeed('main')
    mockRestore.mockRejectedValue(new Error('backup unavailable'))
    await switchNetwork('test')

    expect(restores().map(([chain]) => chain)).toEqual(['main', 'test'])
    // The fresh testnet database is gone, so nothing half-replayed is ever opened.
    const testnetDb = mockUnregisterDb.mock.calls.find(([, chain]) => chain === 'test')?.[2]
    expect(testnetDb).toMatch(/testnet-\d+\.db$/)
    expect(mockDeleteDatabaseAsync).toHaveBeenCalledWith(testnetDb)
    expect(dbsOf(P[0].identityKey, 'test')).toEqual([])
    // The user is back on a working mainnet wallet and told what happened.
    expect(wallet.selectedNetwork).toBe('main')
    expect(getProfilesState().profiles[0].network).toBe('main')
    expect(wallet.walletBuilt).toBe(true)
    expect(onToast).toHaveBeenCalledWith('profile_switch_failed:testnet', { type: 'error' })
    expect(wallet.getBackupRestore()).toMatchObject({ phase: 'failed', error: 'backup unavailable' })

    // Trying again replays testnet again, and this time it works.
    mockRestore.mockImplementation(restoredOk)
    await switchNetwork('test')
    expect(restores().map(([chain]) => chain)).toEqual(['main', 'test', 'test'])
    expect(wallet.selectedNetwork).toBe('test')
    expect(wallet.walletBuilt).toBe(true)
    expect(wallet.getBackupRestore().phase).toBe('restored')
  })

  it('a network that already has a local database is never restored over', async () => {
    // This seed was used here on testnet before it was imported again on mainnet.
    mockDbs[`${P[0].identityKey.slice(-8)}-test`] = ['wallet-existing-testnet-1700000000.db']
    await importSeed('main')
    await switchNetwork('test')

    expect(restores().map(([chain]) => chain)).toEqual(['main'])
    expect(wallet.selectedNetwork).toBe('test')
    expect(wallet.walletBuilt).toBe(true)
    expect(dbsOf(P[0].identityKey, 'test')).toEqual(['wallet-existing-testnet-1700000000.db'])
  })

  it('a replay cut short (the app was killed) is replayed again into the database it started', async () => {
    // Imported on mainnet; the switch to testnet created its database and began
    // replaying, then the app died. Testnet is still waiting for its restore.
    const partial = 'wallet-partial-testnet-1700000000.db'
    mockDbs[`${P[0].identityKey.slice(-8)}-test`] = [partial]
    mockDbs[`${P[0].identityKey.slice(-8)}-main`] = ['wallet-main-mainnet-1700000000.db']
    await AsyncStorage.setItem(
      PROFILES_STORAGE_KEY,
      JSON.stringify({
        active: 0,
        profiles: [{ index: 0, network: 'test', identityKey: P[0].identityKey, restorePending: ['test', 'teratest'] }]
      })
    )
    mockSecretsReady = true
    mockGetMnemonic.mockResolvedValue(MNEMONIC)
    await renderProvider()
    await settle()

    expect(restores().map(([chain]) => chain)).toEqual(['test'])
    expect(wallet.walletBuilt).toBe(true)
    expect(getProfilesState().profiles[0].restorePending).toEqual(['teratest'])
  })
})

describe('a wallet created on this device', () => {
  it('never asks the backup server, on any network', async () => {
    await renderProvider()
    await act(async () => wallet.buildWalletFromMnemonic(MNEMONIC))
    await settle()
    expect(wallet.walletBuilt).toBe(true)
    mockSecretsReady = true
    mockGetMnemonic.mockResolvedValue(MNEMONIC)

    await switchNetwork('test')
    await switchNetwork('teratest')

    expect(wallet.walletBuilt).toBe(true)
    expect(wallet.selectedNetwork).toBe('teratest')
    expect(mockRestore).not.toHaveBeenCalled()
    expect(mockListBackups).not.toHaveBeenCalled()
  })
})

describe('profiles', () => {
  it('a discovered profile with backups on two networks restores each the first time it is built there', async () => {
    mockListBackups.mockImplementation((async (args: { primaryKey: number[]; chain: string }) =>
      hex(args.primaryKey) === hex(P[1].primaryKey) && ['main', 'test'].includes(args.chain)
        ? [{ deviceId: 'd', generation: 1 }]
        : []) as any)
    await importSeed('main')
    // Discovery registers profile 1 in the background.
    await settle()
    expect(getProfilesState().profiles[1]).toMatchObject({
      index: 1,
      network: 'main',
      restorePending: ['main', 'test']
    })

    await act(async () => {
      await wallet.switchProfile(1)
    })
    await settle()
    await switchNetwork('test')
    await switchNetwork('teratest')

    expect(restores()).toEqual([
      ['main', hex(P[0].primaryKey)],
      ['main', hex(P[1].primaryKey)],
      ['test', hex(P[1].primaryKey)]
    ])
    expect(wallet.walletBuilt).toBe(true)
  })
})

describe('a recovered-key (WIF) wallet', () => {
  it('restores another network the first time it is switched to', async () => {
    await renderProvider()
    await act(async () => wallet.buildWalletFromRecoveredKey(WIF_KEY.toWif(), { restoreFromBackup: true }))
    await settle()
    expect(wallet.walletBuilt).toBe(true)
    mockSecretsReady = true
    mockGetRecoveredKey.mockResolvedValue(WIF_KEY.toWif())

    await switchNetwork('test')

    expect(restores()).toEqual([
      ['main', hex(WIF_KEY.toArray())],
      ['test', hex(WIF_KEY.toArray())]
    ])
    expect(wallet.selectedNetwork).toBe('test')
    expect(wallet.walletBuilt).toBe(true)
  })

  it("does not inherit another seed's pending restores", async () => {
    // Profile 0 was imported from a seed and still had testnet waiting; this
    // device now holds a different, recovered key.
    await AsyncStorage.setItem(
      PROFILES_STORAGE_KEY,
      JSON.stringify({
        active: 0,
        profiles: [{ index: 0, network: 'main', identityKey: P[0].identityKey, restorePending: ['test'] }]
      })
    )
    await renderProvider()
    await act(async () => wallet.buildWalletFromRecoveredKey(WIF_KEY.toWif()))
    await settle()
    mockSecretsReady = true
    mockGetRecoveredKey.mockResolvedValue(WIF_KEY.toWif())

    await switchNetwork('test')

    expect(mockRestore).not.toHaveBeenCalled()
    expect(wallet.walletBuilt).toBe(true)
  })
})
