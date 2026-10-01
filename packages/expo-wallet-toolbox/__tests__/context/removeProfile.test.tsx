/**
 * Removing a wallet profile through WalletContext: the glue around the flow in
 * core/profiles/removeProfile (which has its own suite for ordering and abort
 * paths) — that a removal runs as a profile transition, that its dependencies
 * do what the flow expects of them against the real store and the real purge,
 * and that a tombstone left by an interrupted removal is purged again at startup.
 *
 * Same harness as switchProfile.test: the wallet build is bypassed, so there is
 * no open database to ask. The flow itself is therefore scripted, and what is
 * under test is what the provider hands it.
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
import { fake as secureStoreFake } from '../__mocks__/secureStoreFake'
import { arcApiTokenStorageKey } from '../../core/constants'
import type { RemoveProfileDeps, RemoveProfileResult } from '../../core/profiles/removeProfile'

// The provider now requires the host to have stated its endpoints — see
// core/toolboxConfig.ts. A backup URL keeps the restore-on-import path live;
// without one, restoreOnImport is never reached.
beforeEach(() => {
  configureToolbox({ backupUrl: 'https://backup.example.com' })
})
afterEach(() => {
  resetToolboxConfig()
})

// The bare `t` of an uninitialised i18next returns the key, which hides the label
// a toast carries. Stable across renders: the provider lists `t` as a dependency.
const mockT = (key: string, opts?: Record<string, unknown>) =>
  key === 'profile_label' ? `profile${opts?.number}` : opts?.profile ? `${key}:${opts.profile}` : key
jest.mock('react-i18next', () => ({
  ...jest.requireActual('react-i18next'),
  useTranslation: () => ({ t: mockT, i18n: {} })
}))

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
const mockPurgeIdentityDbFiles = jest.fn(async (_keySuffix: string, _deleteFile: unknown) => {})
const mockFlow = jest.fn<Promise<RemoveProfileResult>, [RemoveProfileDeps]>()
const mockCheck = jest.fn()
/** The wallet build is bypassed, so no storage or user id ever arrives: let the flow start anyway. */
let mockBuildReady = true
jest.mock('../../core/profiles/removeProfile', () => {
  const actual = jest.requireActual('../../core/profiles/removeProfile')
  return {
    ...actual,
    removeProfileFlow: (...a: [RemoveProfileDeps]) => mockFlow(...a),
    checkProfileRemoval: (...a: unknown[]) => mockCheck(...a),
    removalRefusal: (deps: RemoveProfileDeps) => {
      const refusal = actual.removalRefusal(deps)
      return mockBuildReady && refusal === 'not-ready' ? null : refusal
    }
  }
})

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
let mockOnline = false
let mockProbe = false
jest.mock('../../core/net/online', () => ({
  getOnline: async () => mockOnline,
  probeOnline: async () => mockProbe,
  subscribeOnline: () => () => {}
}))
const mockLookupProfile = jest.fn()
jest.mock('../../core/identity/handleRegistry/client', () => ({
  createHandleRegistryClient: () => ({ domain: 'deggen.com', lookupProfile: mockLookupProfile })
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
  purgeIdentityDbFiles: (...args: [string, unknown]) => mockPurgeIdentityDbFiles(...args),
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

async function renderProvider(onToast?: React.ComponentProps<typeof WalletContextProvider>['onToast']) {
  renderer = render(
    <WalletContextProvider onToast={onToast}>
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
  secureStoreFake.__reset()
  mockRecover.mockClear()
  mockBuildReady = true
  mockOnline = false
  mockProbe = false
  mockLookupProfile.mockReset()
})

/** Profile indices derived since the last clear. A build of profile n also
 * derives profile 0 to check the store belongs to this seed. */
const derivedIndices = () => mockRecover.mock.calls.map(c => c[2] ?? 0)
const lastProfileIndexBuilt = () => mockRecover.mock.calls.at(-1)?.[2]

async function renderBuilt(onToast?: Parameters<typeof renderProvider>[0]) {
  mockSecretsReady = true
  mockGetMnemonic.mockResolvedValue('synthetic test key')
  await renderProvider(onToast)
  await act(async () => {})
  expect(wallet.walletBuilt).toBe(true)
}

const IDENTITY_1 = '02' + 'ab'.repeat(32)
const IDENTITY_2 = '03' + 'cd'.repeat(32)

/** Profiles 0, 1 and 2, with `active` open; profile 1 has recorded its identity. */
const stored = (active: number, extra: Record<number, object> = {}) =>
  AsyncStorage.setItem(
    PROFILES_STORAGE_KEY,
    JSON.stringify({
      active,
      profiles: [
        { index: 0, network: 'main' },
        { index: 1, network: 'main', identityKey: IDENTITY_1, ...extra[1] },
        { index: 2, network: 'test', identityKey: IDENTITY_2, ...extra[2] }
      ]
    })
  )

const removed: RemoveProfileResult = { kind: 'removed', index: 1 }

beforeEach(() => {
  mockFlow.mockReset()
  mockCheck.mockReset()
  mockPurgeIdentityDbFiles.mockClear()
})

describe('removeProfile', () => {
  it('is not offered, and no transition starts, for profile 0', async () => {
    await renderBuilt()
    let result: RemoveProfileResult | undefined
    await act(async () => {
      result = await wallet.removeProfile()
    })
    expect(result).toEqual({ kind: 'refused', reason: 'profile-zero' })
    expect(mockFlow).not.toHaveBeenCalled()
    expect(wallet.switchingProfile).toBe(false)
    expect(wallet.removingProfile).toBeNull()
  })

  it('is refused on a recovered-key wallet, which has no profiles', async () => {
    await renderProvider()
    await act(async () => wallet.buildWalletFromRecoveredKey(new PrivateKey(21).toWif()))
    expect(wallet.walletBuilt).toBe(true)
    let result: RemoveProfileResult | undefined
    await act(async () => {
      result = await wallet.removeProfile()
    })
    expect(result).toEqual({ kind: 'refused', reason: 'unsupported' })
    expect(mockFlow).not.toHaveBeenCalled()
  })

  it('does not start before the wallet is open: the proof of emptiness needs its database', async () => {
    mockBuildReady = false
    await stored(1)
    await renderBuilt()
    let result: RemoveProfileResult | undefined
    await act(async () => {
      result = await wallet.removeProfile()
    })
    // The bypassed build opens no storage, which is exactly a wallet that is not ready.
    expect(result).toEqual({ kind: 'refused', reason: 'not-ready' })
    expect(mockFlow).not.toHaveBeenCalled()
    expect(wallet.switchingProfile).toBe(false)
  })

  it('runs as a profile transition: the cover is up for the whole flow and names the profile', async () => {
    await stored(1)
    await renderBuilt()
    let finish: (r: RemoveProfileResult) => void = () => {}
    mockFlow.mockImplementation(() => new Promise(resolve => (finish = resolve)))
    let pending!: Promise<RemoveProfileResult>
    await act(async () => {
      pending = wallet.removeProfile()
    })
    expect(mockFlow).toHaveBeenCalledTimes(1)
    expect(wallet.switchingProfile).toBe(true)
    expect(wallet.removingProfile).toBe(1)
    await act(async () => {
      finish(removed)
    })
    expect(await pending).toEqual(removed)
    expect(wallet.switchingProfile).toBe(false)
    expect(wallet.removingProfile).toBeNull()
  })

  it('the cover comes down when the flow throws, and the error is not swallowed', async () => {
    await stored(1)
    await renderBuilt()
    mockFlow.mockRejectedValue(new Error('boom'))
    await act(async () => {
      await expect(wallet.removeProfile()).rejects.toThrow('boom')
    })
    expect(wallet.switchingProfile).toBe(false)
    expect(wallet.removingProfile).toBeNull()
  })

  it('a second removal while one runs is refused as busy and starts no second flow', async () => {
    await stored(1)
    await renderBuilt()
    let finish: (r: RemoveProfileResult) => void = () => {}
    mockFlow.mockImplementation(() => new Promise(resolve => (finish = resolve)))
    let first!: Promise<RemoveProfileResult>
    let second: RemoveProfileResult | undefined
    await act(async () => {
      first = wallet.removeProfile()
    })
    await act(async () => {
      second = await wallet.removeProfile()
    })
    expect(second).toEqual({ kind: 'refused', reason: 'busy' })
    expect(mockFlow).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish(removed)
    })
    await first
  })

  it('the check is refused as busy while a switch is running, and asks the flow otherwise', async () => {
    await stored(1)
    await renderBuilt()
    mockCheck.mockResolvedValue({ kind: 'ok', handle: 'dee@deggen.com' })
    let answer: unknown
    await act(async () => {
      answer = await wallet.checkProfileRemoval()
    })
    expect(answer).toEqual({ kind: 'ok', handle: 'dee@deggen.com' })
    expect(mockCheck).toHaveBeenCalledTimes(1)
    expect(mockCheck.mock.calls[0][0]).toMatchObject({ index: 1, supported: true })
    expect(wallet.switchingProfile).toBe(false)

    let finish: (r: RemoveProfileResult) => void = () => {}
    mockFlow.mockImplementation(() => new Promise(resolve => (finish = resolve)))
    let running!: Promise<RemoveProfileResult>
    await act(async () => {
      running = wallet.removeProfile()
    })
    await act(async () => {
      answer = await wallet.checkProfileRemoval()
    })
    expect(answer).toEqual({ kind: 'refused', reason: 'busy' })
    expect(mockCheck).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish(removed)
    })
    await running
  })

  describe('the dependencies it hands the flow', () => {
    /** Run the flow's own sequence by hand, so the provider's side of each step is what is observed. */
    const run = async (script: (deps: RemoveProfileDeps) => Promise<RemoveProfileResult>) => {
      mockFlow.mockImplementation(script)
      let result: RemoveProfileResult | undefined
      await act(async () => {
        result = await wallet.removeProfile()
      })
      return result
    }

    it('describe the open profile', async () => {
      await stored(1)
      await renderBuilt()
      let seen: RemoveProfileDeps | undefined
      await run(async deps => {
        seen = deps
        return removed
      })
      expect(seen).toMatchObject({ index: 1, supported: true })
      expect(seen!.activeIndex()).toBe(1)
      // The build recorded the identity it derived over the fixture's.
      expect(seen!.record()).toMatchObject({ index: 1, identityKey: new PrivateKey(22).toPublicKey().toString() })
    })

    it('switch to profile 0 with the normal switch, then tombstone, purge and sweep what belongs to the profile alone', async () => {
      await stored(1)
      await AsyncStorage.multiSet([
        ['wallet_user_avatar_icon', 'ionicons/rocket'],
        ['wallet_user_avatar_icon__p1', 'ionicons/leaf'],
        ['connections__p1', '[]'],
        ['connections__p2', '[]'],
        ['backupPushEnabled__p1', 'false']
      ])
      await secureStoreFake.setItemAsync(`${arcApiTokenStorageKey('main')}__p1`, 'p1-token', undefined)
      await secureStoreFake.setItemAsync(`${arcApiTokenStorageKey('main')}__p2`, 'p2-token', undefined)
      await renderBuilt()
      expect(wallet.activeProfile).toBe(1)

      const order: string[] = []
      const result = await run(async deps => {
        order.push(`active:${deps.activeIndex()}`)
        order.push(`switched:${await deps.switchToDefault()}`)
        order.push(`active:${deps.activeIndex()}`)
        await deps.tombstone(IDENTITY_1)
        await deps.purge({ index: 1, identityKey: IDENTITY_1 })
        await deps.unregisterPush({ index: 1, identityKey: IDENTITY_1 })
        return removed
      })

      expect(result).toEqual(removed)
      expect(order).toEqual(['active:1', 'switched:true', 'active:0'])
      expect(wallet.activeProfile).toBe(0)
      expect(wallet.walletBuilt).toBe(true)
      expect(lastProfileIndexBuilt()).toBe(0)
      expect(getProfilesState().profiles[1]).toMatchObject({ deleted: true, identityKey: IDENTITY_1 })
      expect(getProfilesState().profiles.map(p => p.index)).toEqual([0, 1, 2])
      expect(JSON.parse((await AsyncStorage.getItem(PROFILES_STORAGE_KEY))!).profiles[1].deleted).toBe(true)
      // Its databases, found by the last eight characters of its identity.
      expect(mockPurgeIdentityDbFiles).toHaveBeenCalledTimes(1)
      expect(mockPurgeIdentityDbFiles.mock.calls[0][0]).toBe(IDENTITY_1.slice(-8))
      // Its keys, and only its keys.
      expect((await AsyncStorage.getAllKeys()).slice().sort()).toEqual(
        ['connections__p2', 'wallet_profiles_v1', 'wallet_user_avatar_icon'].sort()
      )
      expect(secureStoreFake.__get(`${arcApiTokenStorageKey('main')}__p1`)).toBeUndefined()
      expect(secureStoreFake.__get(`${arcApiTokenStorageKey('main')}__p2`)).toBe('p2-token')
    })

    it('refuse a tombstone while the profile is still the open one', async () => {
      await stored(1)
      await renderBuilt()
      await run(async deps => {
        await expect(deps.tombstone(IDENTITY_1)).rejects.toThrow('The active profile cannot be removed')
        return { kind: 'failed', message: 'x' }
      })
      expect(getProfilesState().profiles[1].deleted).toBeUndefined()
    })

    it('a switch that does not land reports false and leaves the profile alone', async () => {
      // Profile 0 awaits a restore, so a real build of it reaches the backup and fails there.
      await AsyncStorage.setItem(
        PROFILES_STORAGE_KEY,
        JSON.stringify({
          active: 1,
          profiles: [
            { index: 0, network: 'main', needsRestore: true },
            { index: 1, network: 'main', identityKey: IDENTITY_1 }
          ]
        })
      )
      await renderBuilt()
      mockBuildMode = 'real'
      // The switch falls back to the profile it came from, which is not a landing.
      mockRegisteredDbs = []
      mockRestore.mockImplementation(async () => {
        mockBuildMode = 'bypass'
        throw new Error('backup unavailable')
      })
      let landed: boolean | undefined
      await run(async deps => {
        landed = await deps.switchToDefault()
        return { kind: 'switch-failed' }
      })
      expect(landed).toBe(false)
      expect(wallet.activeProfile).toBe(1)
      expect(getProfilesState().profiles[1].deleted).toBeUndefined()
    })

    /** Profile 1 open, with whatever the test needs configured, and the deps the flow would get. */
    const depsOnProfileOne = async () => {
      await stored(1)
      await renderBuilt()
      let seen!: RemoveProfileDeps
      await run(async deps => {
        seen = deps
        return removed
      })
      return seen
    }

    describe('online', () => {
      it('is what NetInfo says when it says online', async () => {
        mockOnline = true
        const deps = await depsOnProfileOne()
        expect(await deps.online()).toBe(true)
      })

      it('does not take an offline verdict on trust: a live request that gets through says online', async () => {
        mockProbe = true
        const deps = await depsOnProfileOne()
        expect(await deps.online()).toBe(true)
      })

      it('is offline only when both agree', async () => {
        const deps = await depsOnProfileOne()
        expect(await deps.online()).toBe(false)
      })
    })

    describe('the handle', () => {
      const withRegistry = () =>
        configureToolbox({
          backupUrl: 'https://backup.example.com',
          handleRegistry: { main: { domain: 'deggen.com', url: 'https://registry.example' } }
        })

      it('is none where no registry is configured, and the registry is not asked', async () => {
        const deps = await depsOnProfileOne()
        expect(await deps.lookupHandle(IDENTITY_1)).toEqual({ kind: 'none' })
        expect(mockLookupProfile).not.toHaveBeenCalled()
      })

      it('is what the registry reports for the identity, by paymail', async () => {
        withRegistry()
        const deps = await depsOnProfileOne()
        mockLookupProfile.mockResolvedValue({ kind: 'found', profile: { paymail: 'dee@deggen.com' } })
        expect(await deps.lookupHandle(IDENTITY_1)).toEqual({ kind: 'found', paymail: 'dee@deggen.com' })
        expect(mockLookupProfile).toHaveBeenCalledWith(IDENTITY_1)
      })

      it('is none when the registry says this identity holds nothing', async () => {
        withRegistry()
        const deps = await depsOnProfileOne()
        mockLookupProfile.mockResolvedValue({ kind: 'none' })
        expect(await deps.lookupHandle(IDENTITY_1)).toEqual({ kind: 'none' })
      })

      it('is failed, not none, when the registry did not answer', async () => {
        withRegistry()
        const deps = await depsOnProfileOne()
        mockLookupProfile.mockResolvedValue({ kind: 'failed' })
        expect(await deps.lookupHandle(IDENTITY_1)).toEqual({ kind: 'failed' })
      })

      it('cannot be released without a live wallet to sign for it, and has no journal to settle', async () => {
        withRegistry()
        const deps = await depsOnProfileOne()
        expect(await deps.releaseHandle('dee@deggen.com')).toEqual({ kind: 'unavailable' })
        expect(await deps.settleHandleJournal()).toBe(true)
      })
    })

    it('prove nothing without an open database and an inbox pass: the check fails closed', async () => {
      const deps = await depsOnProfileOne()
      expect(await deps.checkEmpty()).toEqual({ ok: false, reasons: ['check-failed'] })
    })

    it('leave the push hook a no-op for now: it resolves and changes nothing', async () => {
      await stored(1)
      await renderBuilt()
      const before = JSON.stringify(getProfilesState())
      await run(async deps => {
        await expect(deps.unregisterPush({ index: 1, identityKey: IDENTITY_1 })).resolves.toBeUndefined()
        return removed
      })
      expect(JSON.stringify(getProfilesState())).toBe(before)
    })
  })
})

describe('the startup purge of a removed profile', () => {
  const leftovers = async () => {
    await AsyncStorage.multiSet([
      ['connections__p1', '[]'],
      ['wallet_user_avatar_icon__p1', 'ionicons/leaf'],
      ['connections__p2', '[]'],
      ['wallet_user_avatar_icon', 'ionicons/rocket']
    ])
    await secureStoreFake.setItemAsync(`${arcApiTokenStorageKey('main')}__p1`, 'p1-token', undefined)
    await secureStoreFake.setItemAsync(`${arcApiTokenStorageKey('main')}__p2`, 'p2-token', undefined)
  }

  it('finishes what an interrupted removal left: its databases, its token and its keys', async () => {
    await stored(0, { 1: { deleted: true } })
    await leftovers()
    await renderBuilt()
    await act(async () => {})
    expect(mockPurgeIdentityDbFiles).toHaveBeenCalledTimes(1)
    expect(mockPurgeIdentityDbFiles.mock.calls[0][0]).toBe(IDENTITY_1.slice(-8))
    expect((await AsyncStorage.getAllKeys()).slice().sort()).toEqual(
      ['connections__p2', 'wallet_profiles_v1', 'wallet_user_avatar_icon'].sort()
    )
    expect(secureStoreFake.__get(`${arcApiTokenStorageKey('main')}__p1`)).toBeUndefined()
    expect(secureStoreFake.__get(`${arcApiTokenStorageKey('main')}__p2`)).toBe('p2-token')
  })

  it('leaves live profiles alone, and does nothing when none was removed', async () => {
    await stored(0)
    await leftovers()
    await renderBuilt()
    await act(async () => {})
    expect(mockPurgeIdentityDbFiles).not.toHaveBeenCalled()
    expect((await AsyncStorage.getAllKeys()).filter(k => k.endsWith('__p1'))).toHaveLength(2)
  })

  it('is idempotent: a second launch finds nothing left and changes nothing', async () => {
    await stored(0, { 1: { deleted: true } })
    await leftovers()
    await renderBuilt()
    await act(async () => {})
    const keys = (await AsyncStorage.getAllKeys()).slice().sort()
    await act(async () => renderer.unmount())
    mockPurgeIdentityDbFiles.mockClear()
    __resetProfilesForTests()
    await renderBuilt()
    await act(async () => {})
    expect((await AsyncStorage.getAllKeys()).slice().sort()).toEqual(keys)
    expect(getProfilesState().profiles[1]).toMatchObject({ deleted: true })
  })

  it('a tombstone with no recorded identity still has its keys swept, and a database purge that throws does not stop startup', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    await stored(0, { 1: { deleted: true, identityKey: undefined } })
    mockPurgeIdentityDbFiles.mockRejectedValueOnce(new Error('registry unreadable'))
    await leftovers()
    await renderBuilt()
    await act(async () => {})
    expect(wallet.walletBuilt).toBe(true)
    expect((await AsyncStorage.getAllKeys()).filter(k => k.endsWith('__p1'))).toEqual([])
  })

  it('never reaches the wallet it opens: profile 0 builds as usual', async () => {
    await stored(0, { 1: { deleted: true } })
    await leftovers()
    await renderBuilt()
    expect(wallet.activeProfile).toBe(0)
    expect(lastProfileIndexBuilt()).toBe(0)
  })
})
