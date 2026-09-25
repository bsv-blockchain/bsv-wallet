// XR-085 review follow-up: WalletContext's refreshProof() looks up an
// action's offline status with its own findOfflineActions(db, { status:
// ['queued', 'posting'] }) call, independent of the one XR-085 already
// widened in the drain path. An 'import_hold' row (a quarantined,
// possibly-already-broadcast row copied in by a raw database import) is
// invisible to that lookup, so refreshProof sees offlineStatus=undefined,
// shouldFailUnprovenTx falls through its normal in-flight/staleness check,
// and a manual "Refresh" tap on the row (WalletHomeScreen's onRefreshTx)
// can mark it 'failed' and release its inputs -- exactly what XR-085's own
// commit says must never happen to an import_hold row.
//
// Same module-load stubs as walletBuildRestore.test.tsx: the provider
// reaches native-module-backed singletons (vault store, secrets policy) at
// import time.
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import React from 'react'
import { act, render } from '@testing-library/react-native'
import { PrivateKey } from '@bsv/sdk'
import { WalletContextProvider, useWallet } from '../../core/context/WalletContext'
import { configureToolbox, resetToolboxConfig } from '../../core/toolboxConfig'
import { findOfflineActions } from '../../core/storage/methods/offlineActions'
import type { OfflineActionRow } from '../../core/storage/methods/offlineActions'

beforeEach(() => {
  configureToolbox({ backupUrl: 'https://backup.example.com' })
})
afterEach(() => {
  resetToolboxConfig()
})

jest.mock('../../core/storage/methods/offlineActions', () => {
  const actual = jest.requireActual('../../core/storage/methods/offlineActions')
  return { ...actual, findOfflineActions: jest.fn() }
})
const mockedFindOfflineActions = findOfflineActions as jest.Mock

const mockGetMnemonic = jest.fn<Promise<string | null>, []>()
const mockGetItem = jest.fn(async () => null)
const mockSetItem = jest.fn(async () => {})
const mockDestroy = jest.fn(async () => {})
const mockFindTransactions = jest.fn()
const mockUpdateTransactionStatus = jest.fn(async () => {})
const mockManagers: any[] = []
let mockBuildMode: 'bypass' | 'real' = 'bypass'

jest.mock('../../core/context/LocalStorageProvider', () => ({
  useLocalStorage: () => ({
    getMnemonic: mockGetMnemonic,
    getRecoveredKey: jest.fn(async () => null),
    getItem: mockGetItem,
    setItem: mockSetItem,
    deleteAllWalletKeys: jest.fn(),
    secretsReady: false
  })
}))
jest.mock(
  '@bsv/btms-permission-module',
  () => ({
    // Halts the build right after storage is published (setStorage runs
    // earlier in the same function) -- same technique walletBuildRestore.test.tsx
    // uses to stop a 'real' build without standing up the whole permission stack.
    createBtmsModule: () => {
      throw new Error('Reached post-storage setup')
    }
  }),
  { virtual: true }
)
jest.mock('../../core/backup/restoreOnImport', () => ({
  restoreOnImport: jest.fn().mockRejectedValue(new Error('unused in this test'))
}))
jest.mock('../../core/mnemonicWallet', () => ({
  recoverMnemonicWallet: () => {
    const { PrivateKey: RealPrivateKey } = jest.requireActual('@bsv/sdk')
    const key = new RealPrivateKey(21)
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
  getRegisteredDbs: async () => ['refresh-import-hold-test.db'],
  selectLatestDb: () => 'refresh-import-hold-test.db'
}))
// The one difference from walletBuildRestore.test.tsx's storage mock: this
// instance also answers the calls refreshProof() makes directly against
// storage (findTransactions / updateTransactionStatus / sqliteDb), so the
// bug under test -- a manual refresh releasing an import_hold row's inputs
// -- is reachable without a real SQLite database.
jest.mock('../../core/storage', () => ({
  StorageExpoSQLite: class {
    db = {}
    sqliteDb = {}
    setServices() {}
    async migrate() {}
    destroy = mockDestroy
    findTransactions = mockFindTransactions
    updateTransactionStatus = mockUpdateTransactionStatus
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

const HELD_TXID = 'held-import-hold-txid'

beforeEach(() => {
  jest.clearAllMocks()
  mockBuildMode = 'bypass'
  mockManagers.length = 0
  mockGetMnemonic.mockResolvedValue(null)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
  ;(globalThis as any).__jsStallWatchdog = true

  // Stand-in for the real DB: honors the status filter the way the real
  // findOfflineActions()/SQL WHERE...IN clause would, over one seeded row
  // whose actual status is 'import_hold'.
  const seeded: OfflineActionRow = {
    offlineActionId: 1,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    userId: 1,
    txid: HELD_TXID,
    seq: 1,
    role: 'sent',
    senderIdentityKey: null,
    receivedVia: null,
    status: 'import_hold',
    rejectedReason: null,
    poisonedByTxid: null,
    framePayload: null
  }
  mockedFindOfflineActions.mockImplementation(async (_db: unknown, filter: { status?: string[] } = {}) => {
    if (!filter.status || filter.status.length === 0) return [seeded]
    return filter.status.includes(seeded.status) ? [seeded] : []
  })

  // Stale (>5min old), in-flight underlying tx -- exactly the shape an
  // imported-but-unresolved payment has: shouldFailUnprovenTx's own
  // staleness/IN_FLIGHT check would otherwise call this ripe for failing.
  mockFindTransactions.mockResolvedValue([
    {
      status: 'nosend',
      updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      transactionId: 42
    }
  ])

  // Neither WoC endpoint has anything to say about this txid: no proof, and
  // not found on chain either -- the "not on chain" branch that decides
  // pending vs. failed.
  ;(global as any).fetch = jest.fn(async (url: string) => {
    if (typeof url === 'string' && (url.includes('/proof/bump') || url.includes('/tx/hash/'))) {
      return { ok: false, status: 404, text: async () => '' } as any
    }
    throw new Error(`unexpected fetch in test: ${url}`)
  })
})

afterEach(async () => {
  await act(async () => renderer?.unmount())
  jest.restoreAllMocks()
})

async function buildWithStorage() {
  await renderProvider()
  mockBuildMode = 'real'
  mockGetMnemonic.mockResolvedValue('synthetic test key')
  // restoreFromBackup: false skips the encrypted-restore branch entirely and
  // reaches setStorage(phoneStorage) directly; the forced throw inside
  // createBtmsModule (mocked above) then halts the build without ever
  // resetting `storage` back to null, leaving a fully wired storage object
  // in place for refreshProof to use.
  await act(async () => {
    await wallet.buildWalletFromMnemonic('synthetic test key', { restoreFromBackup: false })
  })
  expect(wallet.storage).toBeTruthy()
}

describe('XR-085: refreshProof and an imported import_hold row', () => {
  it('never fails/releases an import_hold row it cannot prove on or off chain', async () => {
    await buildWithStorage()

    let outcome: 'confirmed' | 'pending' | 'failed' | undefined
    await act(async () => {
      outcome = await wallet.refreshProof(HELD_TXID)
    })

    // A held, possibly-already-broadcast import must read as still pending,
    // never failed -- failing it releases the inputs a counterparty may
    // already hold a spend of. (Pre-fix, findOfflineActions was queried
    // without 'import_hold', the row was invisible to the lookup, and this
    // came back 'failed' with updateTransactionStatus('failed', 42) called.)
    expect(outcome).toBe('pending')
    expect(mockUpdateTransactionStatus).not.toHaveBeenCalled()
  })
})
