/**
 * Push for every profile, through the real provider build: the build derives the
 * other profiles' identities from the seed, registers each as itself at its own
 * host (the open one last), routes a tap to the profile it is for, and withdraws
 * the registrations when a profile is removed or the wallet is deleted.
 *
 * The build runs for real up to the monitor, which is stubbed: everything else
 * the push wiring depends on (the keys, the store, the host settings, the
 * build-generation checks) is the provider's own.
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
import { __resetProfilesForTests, PROFILES_STORAGE_KEY } from '../../core/profiles/profileStore'
import { TaskCreditInbox } from '../../core/monitor/TaskCreditInbox'
import { PUSH_REGISTRATION_KEY, PUSH_REGISTRATION_OWNER_KEY } from '../../core/push/registration'
import type { RemoveProfileDeps, RemoveProfileResult } from '../../core/profiles/removeProfile'
import type { PushAdapter, PushOpenedEvent } from '../../core/push/types'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const hd = hdFromMnemonic(MNEMONIC)
const ID = [0, 1, 2].map(n => deriveProfileKeys(hd, n).identityKey)

let mockSecretsReady = true
const mockGetMnemonic = jest.fn<Promise<string | null>, []>()
const mockGetRecoveredKey = jest.fn<Promise<string | null>, []>()
const mockRegistrations: Array<{ identityKey: string; host: string; token: string }> = []
const mockPosts: Array<{ identityKey: string; url: string; token: string }> = []
let mockPostStatus = 200
let mockRegisteredDbs: string[] = []

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
import { router as mockRouter } from 'expo-router'
jest.mock('react-native-sse', () => ({ __esModule: true, default: class {} }))
jest.mock('@bsv/btms-permission-module', () => ({ createBtmsModule: () => ({}) }), { virtual: true })
jest.mock('../../core/backup/restoreOnImport', () => ({ restoreOnImport: jest.fn(async () => ({ restored: false })) }))
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
jest.mock('../../core/walletDbRegistry', () => ({
  getRegisteredDbs: async () => mockRegisteredDbs,
  registerDb: async (_s: string, _c: string, filename: string) => void mockRegisteredDbs.push(filename),
  unregisterDb: async () => {},
  purgeIdentityDbFiles: async () => {},
  purgeRegisteredDbFiles: async () => {},
  selectLatestDb: (names: string[]) => jest.requireActual('../../core/walletDbRegistry').selectLatestDb(names)
}))
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('expo-sqlite is native')
  },
  deleteDatabaseAsync: async () => {}
}))
jest.mock('../../core/storage', () => ({
  StorageExpoSQLite: class {
    db = {}
    dbName = 'test.db'
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
// The registration's client records who signed in: the wallet it was given is the
// profile's own ProtoWallet, so its identity is the profile's.
jest.mock('@bsv/message-box-client', () => ({
  MessageBoxClient: class {
    opts: { host: string; walletClient: any }
    constructor(opts: { host: string; walletClient: any }) {
      this.opts = opts
    }
    async registerDevice(params: { fcmToken: string }, host: string) {
      const { publicKey } = await this.opts.walletClient.getPublicKey({ identityKey: true })
      mockRegistrations.push({ identityKey: publicKey, host, token: params.fcmToken })
      return { status: 'success' }
    }
  },
  PeerPayClient: class {}
}))
const mockFlow = jest.fn<Promise<RemoveProfileResult>, [RemoveProfileDeps]>()
jest.mock('../../core/profiles/removeProfile', () => ({
  ...jest.requireActual('../../core/profiles/removeProfile'),
  // The flow itself is covered on its own (profiles/removeProfile.test.ts); here a script
  // drives the dependencies the provider hands it, the real ones.
  removalRefusal: () => null,
  removeProfileFlow: (deps: RemoveProfileDeps) => mockFlow(deps)
}))
jest.mock('../../core/push/identities', () => {
  const actual = jest.requireActual('../../core/push/identities')
  return {
    ...actual,
    authPostFor: (wallet: any) => async (url: string, body: { fcmToken: string }) => {
      const { publicKey } = await wallet.getPublicKey({ identityKey: true })
      mockPosts.push({ identityKey: publicKey, url, token: body.fcmToken })
      return { status: mockPostStatus }
    }
  }
})
jest.mock('@bsv/wallet-toolbox-mobile', () => {
  const actual = jest.requireActual('@bsv/wallet-toolbox-mobile')
  return {
    ...actual,
    Wallet: class {
      settingsManager = {}
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

let handlers: {
  opened?: (e: PushOpenedEvent) => void
  fg?: (e: PushOpenedEvent) => void
  token?: (t: string) => void
} = {}
let currentToken = 'fcm-token-1'
const adapter: PushAdapter = {
  platform: 'ios',
  getPermission: async () => 'granted',
  requestPermission: async () => 'granted',
  getToken: async () => currentToken,
  onTokenRefresh: cb => {
    handlers.token = cb
    return () => {
      delete handlers.token
    }
  },
  onNotificationOpened: cb => {
    handlers.opened = cb
    return () => {
      delete handlers.opened
    }
  },
  getInitialNotification: async () => null,
  onForegroundMessage: cb => {
    handlers.fg = cb
    return () => {
      delete handlers.fg
    }
  },
  openSettings: async () => {}
}

let wallet: ReturnType<typeof useWallet>
function ObserveWallet() {
  wallet = useWallet()
  return null
}
let renderer: ReturnType<typeof render>

/** Let the registration run: it starts when the build finishes and nothing awaits it. */
const settle = () => act(async () => new Promise<void>(resolve => setTimeout(resolve, 150)))

async function storeProfiles(active: number, extra: Record<number, object> = {}) {
  await AsyncStorage.setItem(
    PROFILES_STORAGE_KEY,
    JSON.stringify({
      active,
      profiles: [0, 1, 2].map(index => ({ index, network: 'main', identityKey: ID[index], ...extra[index] }))
    })
  )
}

async function renderBuilt() {
  renderer = render(
    <WalletContextProvider>
      <ObserveWallet />
    </WalletContextProvider>
  )
  await act(async () => {})
  await settle()
  expect(wallet.walletBuilt).toBe(true)
}

const registered = () => mockRegistrations.map(r => r.identityKey)
const markers = async () => JSON.parse((await AsyncStorage.getItem(PUSH_REGISTRATION_KEY)) ?? '{}')

beforeEach(async () => {
  jest.clearAllMocks()
  mockRegistrations.length = 0
  mockPosts.length = 0
  mockPostStatus = 200
  handlers = {}
  currentToken = 'fcm-token-1'
  mockRegisteredDbs = []
  mockSecretsReady = true
  mockGetMnemonic.mockResolvedValue(MNEMONIC)
  mockGetRecoveredKey.mockResolvedValue(null)
  await AsyncStorage.clear()
  __resetProfilesForTests()
  configureToolbox({ backupUrl: 'https://backup.example.com', push: adapter })
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  await act(async () => renderer?.unmount())
  resetToolboxConfig()
  jest.restoreAllMocks()
})

describe('registration at build time', () => {
  it('registers every live profile as itself, the open one last', async () => {
    await storeProfiles(1)
    await renderBuilt()
    expect(wallet.activeProfile).toBe(1)
    expect(registered()).toEqual([ID[0], ID[2], ID[1]])
    expect(mockRegistrations.every(r => r.token === 'fcm-token-1')).toBe(true)
    expect(Object.keys(await markers()).sort()).toEqual([...ID].sort())
    expect(await AsyncStorage.getItem(PUSH_REGISTRATION_OWNER_KEY)).toBe(ID[1])
  })

  it('registers each profile at the MessageBox host of its own settings', async () => {
    await storeProfiles(0)
    await AsyncStorage.setItem('message_box_url__p2', 'https://mb2.example.org')
    await AsyncStorage.setItem('message_box_url', 'https://mb0.example.org')
    await renderBuilt()
    const hostOf = (identityKey: string) => mockRegistrations.find(r => r.identityKey === identityKey)?.host
    expect(hostOf(ID[0])).toBe('https://mb0.example.org')
    expect(hostOf(ID[1])).toBe('https://messagebox.bsvblockchain.tech')
    expect(hostOf(ID[2])).toBe('https://mb2.example.org')
  })

  it('leaves out a profile whose MessageBox is off, and a profile that was removed', async () => {
    await storeProfiles(0, { 2: { deleted: true } })
    await AsyncStorage.setItem('message_box_url__p1', 'noMessageBox')
    await renderBuilt()
    expect(registered()).toEqual([ID[0]])
  })

  it('registers only the one identity of a recovered-key wallet', async () => {
    mockGetMnemonic.mockResolvedValue(null)
    mockGetRecoveredKey.mockResolvedValue(new PrivateKey(31).toWif())
    renderer = render(
      <WalletContextProvider>
        <ObserveWallet />
      </WalletContextProvider>
    )
    await act(async () => {})
    await settle()
    expect(wallet.walletBuilt).toBe(true)
    expect(registered()).toEqual([new PrivateKey(31).toPublicKey().toString()])
  })

  it('registers nothing when the host wired no push', async () => {
    configureToolbox({ backupUrl: 'https://backup.example.com' })
    await storeProfiles(0)
    await renderBuilt()
    expect(registered()).toEqual([])
    expect(handlers.opened).toBeUndefined()
  })

  it('a switch registers only what changed: the profile that is now open, last, so it owns the token', async () => {
    await storeProfiles(0)
    await renderBuilt()
    expect(registered()).toEqual([ID[1], ID[2], ID[0]])
    mockRegistrations.length = 0
    await act(async () => {
      await wallet.switchProfile(2)
    })
    await settle()
    expect(wallet.activeProfile).toBe(2)
    expect(registered()).toEqual([ID[2]])
  })
})

describe('a push opened or received', () => {
  it('a tap for another profile switches to it, then opens Activity', async () => {
    await storeProfiles(0)
    await renderBuilt()
    await act(async () => {
      handlers.opened!({ data: { recipient: ID[2], messageBox: 'payment_inbox' } })
    })
    await settle()
    await settle()
    expect(wallet.activeProfile).toBe(2)
    expect(mockRouter.push).toHaveBeenCalledWith('/transactions')
  })

  it('a tap for the open profile (or with no recipient) does not switch', async () => {
    await storeProfiles(1)
    await renderBuilt()
    await act(async () => {
      handlers.opened!({ data: { recipient: ID[1] } })
      handlers.opened!({ data: {} })
    })
    await settle()
    expect(wallet.activeProfile).toBe(1)
    expect(mockRouter.push).toHaveBeenCalledTimes(2)
  })

  it('a tap for a profile that was removed does not switch to it', async () => {
    await storeProfiles(0, { 2: { deleted: true } })
    await renderBuilt()
    await act(async () => {
      handlers.opened!({ data: { recipient: ID[2] } })
    })
    await settle()
    expect(wallet.activeProfile).toBe(0)
  })

  it("a foreground message for another profile does not run the open profile's inbox pass", async () => {
    const requestNow = jest.spyOn(TaskCreditInbox, 'requestNow').mockImplementation(() => {})
    await storeProfiles(0)
    await renderBuilt()
    requestNow.mockClear()
    handlers.fg!({ data: { recipient: ID[1] } })
    expect(requestNow).not.toHaveBeenCalled()
    handlers.fg!({ data: { recipient: ID[0] } })
    handlers.fg!({ data: {} })
    expect(requestNow).toHaveBeenCalledTimes(2)
  })
})

describe('withdrawing registrations', () => {
  it('removing a profile unregisters it, signed as itself, and forgets only its marker', async () => {
    await storeProfiles(1)
    await renderBuilt()
    expect(registered()).toHaveLength(3)

    mockFlow.mockImplementation(async deps => {
      expect(await deps.switchToDefault()).toBe(true)
      await deps.tombstone(ID[1])
      await deps.purge({ index: 1, identityKey: ID[1] })
      await deps.unregisterPush({ index: 1, identityKey: ID[1] })
      return { kind: 'removed', index: 1 }
    })
    await act(async () => {
      expect(await wallet.removeProfile()).toEqual({ kind: 'removed', index: 1 })
    })
    await settle()

    expect(mockPosts).toEqual([
      { identityKey: ID[1], url: 'https://messagebox.bsvblockchain.tech/unregisterDevice', token: 'fcm-token-1' }
    ])
    expect(Object.keys(await markers()).sort()).toEqual([ID[0], ID[2]].sort())
  })

  it('a removed profile is not registered again by a later sync, though the build that runs it still holds its key', async () => {
    await storeProfiles(1)
    await renderBuilt()
    mockFlow.mockImplementation(async deps => {
      expect(await deps.switchToDefault()).toBe(true)
      await deps.tombstone(ID[1])
      await deps.unregisterPush({ index: 1, identityKey: ID[1] })
      return { kind: 'removed', index: 1 }
    })
    await act(async () => {
      await wallet.removeProfile()
    })
    await settle()
    expect(wallet.activeProfile).toBe(0)

    // The OS rotates the token: every live profile registers the new one, and this one is not live.
    mockRegistrations.length = 0
    currentToken = 'fcm-token-2'
    await act(async () => {
      handlers.token!('fcm-token-2')
    })
    await settle()
    expect(registered()).toEqual([ID[2], ID[0]])
    expect(Object.keys(await markers())).not.toContain(ID[1])
  })

  it('a removal the server did not answer leaves the registration on record, and the next build withdraws it', async () => {
    await storeProfiles(1)
    await renderBuilt()
    mockFlow.mockImplementation(async deps => {
      expect(await deps.switchToDefault()).toBe(true)
      await deps.tombstone(ID[1])
      await deps.purge({ index: 1, identityKey: ID[1] })
      await deps.unregisterPush({ index: 1, identityKey: ID[1] })
      return { kind: 'removed', index: 1 }
    })
    mockPostStatus = 503
    await act(async () => {
      await wallet.removeProfile()
    })
    await settle()
    expect(mockPosts).toHaveLength(1)
    expect(Object.keys(await markers())).toContain(ID[1])

    // The next launch: the removed profile is not registered, but its key is derived once more to withdraw it.
    await act(async () => renderer.unmount())
    mockPosts.length = 0
    mockRegistrations.length = 0
    mockPostStatus = 200
    await renderBuilt()
    expect(mockPosts).toEqual([
      { identityKey: ID[1], url: 'https://messagebox.bsvblockchain.tech/unregisterDevice', token: 'fcm-token-1' }
    ])
    expect(registered()).not.toContain(ID[1])
    expect(Object.keys(await markers())).not.toContain(ID[1])
    expect(wallet.activeProfile).toBe(0)
  })

  it('asks nothing for a removed profile that has no registration left on record', async () => {
    await storeProfiles(0, { 2: { deleted: true } })
    await renderBuilt()
    expect(mockPosts).toEqual([])
  })

  it('Delete Wallet unregisters every profile, signed as each, and sweeps the markers', async () => {
    await storeProfiles(1)
    await renderBuilt()
    expect(await AsyncStorage.getItem(PUSH_REGISTRATION_KEY)).not.toBeNull()

    // The secrets really are erased by Delete Wallet; the stub store is not, so say so,
    // or the provider would simply build the same wallet again and register it anew.
    mockGetMnemonic.mockResolvedValue(null)
    let outcome: boolean | undefined
    await act(async () => {
      outcome = await wallet.logout()
    })

    expect(outcome).toBe(true)
    expect(mockPosts.map(p => p.identityKey).sort()).toEqual([...ID].sort())
    expect(mockPosts.every(p => p.url.endsWith('/unregisterDevice') && p.token === 'fcm-token-1')).toBe(true)
    expect(await AsyncStorage.getItem(PUSH_REGISTRATION_KEY)).toBeNull()
    expect(await AsyncStorage.getItem(PUSH_REGISTRATION_OWNER_KEY)).toBeNull()
  })
})
