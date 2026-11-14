/**
 * Hardening: salt allocation checks the chain marker before it uses an index
 * (audit finding salt-reuse; port of audit PoC spend-authority/salt_poc.cjs).
 *
 * The local inventory only knows indexes this phone saw. After a full
 * withdrawal (the witness publishes the salt) and a wiped phone, the next
 * deposit used to re-derive index 1, so the new output shared its salt with
 * the one whose salt was already public. Now every candidate index is looked
 * up on the marker address first; any history at all means "used".
 */
import { LockingScript, Transaction } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'

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
jest.mock('expo-secure-store', () => ({
  ...(() => {
    const store: Record<string, string> = {}
    return {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wutdo',
      getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
      setItemAsync: jest.fn(async (k: string, v: string) => {
        store[k] = v
      }),
      deleteItemAsync: jest.fn(async (k: string) => {
        delete store[k]
      }),
      __clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      }
    }
  })()
}))
jest.mock('../../core/services/vault/ceremonyHost', () => ({
  requestVaultSigner: jest.fn(),
  noteVaultProgress: jest.fn()
}))
jest.mock('../../core/toolboxConfig', () => ({
  getBackupUrl: jest.fn(() => 'https://backup.example'),
  isVaultEnabled: jest.fn(() => true),
  isVaultAvailable: jest.fn(() => true)
}))
jest.mock('../../core/backup/preference', () => ({
  isBackupPushEnabled: jest.fn(async () => true)
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import { requestVaultSigner } from '../../core/services/vault/ceremonyHost'
import { generateMnemonicWallet } from '../../core/mnemonicWallet'
import { vaultStore, type VaultKeyRecord } from '../../core/services/vault/vaultStore'
import {
  resetSaltFloors,
  setVaultChainLookup,
  type MarkerHistory,
  type VaultChainLookup
} from '../../core/services/vault/markerLookup'
import {
  deriveVaultMarkerScript,
  depositToVault,
  relockVault,
  withdrawFromVault
} from '../../core/services/vault/transfers'
import { VaultError } from '../../core/services/vault/types'
import { FakeChain, FakeVaultWallet, fakeChainLookup } from './testSupport/fakeVaultChain'
import { ADMIN, armSigner, buildKeyring, seedOwnMeta } from './testSupport/vaultHarness'
import type { MockYubiKey } from '../../core/services/vault/mockYubiKey'

jest.setTimeout(300_000)

const hex = (a: ArrayLike<number>): string => Array.from(a, b => b.toString(16).padStart(2, '0')).join('')
/** The in-memory salt-floor hint is keyed by storage key (identity + chain).
 * A fresh identity per test keeps one test's hint from hiding a bug in the
 * next. */
let identityCounter = 0
let identityKey = ''

async function wipeStorage(): Promise<void> {
  await AsyncStorage.clear()
  ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
  vaultStore.clearScope()
}

async function markerHex(w: FakeVaultWallet, index: number): Promise<string> {
  return (await deriveVaultMarkerScript(w, ADMIN, 'test', String(index))).toHex()
}

/** Which of indexes 1..max a transaction's marker output belongs to. */
async function markerIndexesIn(w: FakeVaultWallet, chain: FakeChain, txid: string, max = 8): Promise<number[]> {
  const tx = chain.tx(txid)!
  const scripts = tx.outputs.map(o => o.lockingScript.toHex())
  const found: number[] = []
  for (let k = 1; k <= max; k++) if (scripts.includes(await markerHex(w, k))) found.push(k)
  return found
}

/** A 1-sat payment to the marker script of `index` (dust, no vault). */
async function publishDust(w: FakeVaultWallet, chain: FakeChain, index: number, confirmed = true): Promise<string> {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(await markerHex(w, index)) })
  return chain.publish(tx, { confirmed })
}

describe('hardening: salt index checked against the chain (salt-reuse)', () => {
  let mock: MockYubiKey
  let keys: VaultKeyRecord[]
  let primaryKey: number[]
  let chain: FakeChain
  let wallet: FakeVaultWallet

  beforeAll(async () => {
    primaryKey = generateMnemonicWallet().primaryKey
    ;({ mock, keys } = await buildKeyring(2))
  })

  async function startDevice(): Promise<void> {
    // same identity for one test, so device B shares device A's storage key
    vaultStore.clearScope()
    vaultStore.configureScope({ identityKey, chain: 'test' })
    await seedOwnMeta(wallet, {
      v: 6,
      vaultId: hex(p256.utils.randomSecretKey()),
      revision: 1,
      createdAt: Date.now(),
      keys
    })
    armSigner(mock, keys[0].serial)
  }

  beforeEach(async () => {
    identityKey = `02${(++identityCounter).toString(16).padStart(2, '0')}${'e5'.repeat(31)}`
    await wipeStorage()
    resetSaltFloors()
    ;(requestVaultSigner as jest.Mock).mockReset()
    chain = new FakeChain()
    wallet = new FakeVaultWallet(primaryKey, chain)
    setVaultChainLookup(fakeChainLookup(chain))
    await startDevice()
  })
  afterEach(() => setVaultChainLookup(null))

  it('salt-reuse PoC: after deposit at index 1, a full withdrawal and a wiped phone, a new deposit does not reuse index 1', async () => {
    const first = await depositToVault(wallet, ADMIN, 250_000)
    expect(await markerIndexesIn(wallet, chain, first.txid)).toEqual([1])
    await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all', keys[0].serial)

    // Phone lost: new device, same mnemonic, empty local state, same chain.
    wallet.wipeLocalState()
    await wipeStorage()
    const deviceB = new FakeVaultWallet(primaryKey, chain)
    wallet = deviceB
    await startDevice()

    const second = await depositToVault(deviceB, ADMIN, 250_000)
    const markers = await markerIndexesIn(deviceB, chain, second.txid)
    expect(markers).not.toContain(1)
    expect(markers).toEqual([2])
    const secondMarker = chain.tx(second.txid)!.outputs.map(o => o.lockingScript.toHex())
    expect(secondMarker).not.toContain(await markerHex(deviceB, 1))
    expect(secondMarker).toContain(await markerHex(deviceB, 2))
  })

  it('an index with dust-only history is skipped', async () => {
    await publishDust(wallet, chain, 1)
    const dep = await depositToVault(wallet, ADMIN, 250_000)
    expect(await markerIndexesIn(wallet, chain, dep.txid)).toEqual([2])
  })

  it('unknown with no rows refuses before any tap', async () => {
    const lookup: VaultChainLookup = {
      ...fakeChainLookup(chain),
      markerHistory: async () => ({ status: 'unknown', reason: 'request-failed', txids: [] })
    }
    setVaultChainLookup(lookup)
    const createAction = jest.spyOn(wallet, 'createAction')
    const err = await depositToVault(wallet, ADMIN, 250_000).then(
      () => null,
      e => e
    )
    expect(err).toBeInstanceOf(VaultError)
    expect(err.code).toBe('lookup-unknown')
    expect(err.details).toEqual({ reason: 'request-failed', index: 1 })
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(createAction).not.toHaveBeenCalled()
  })

  it('a raw Error from markerHistory becomes lookup-unknown and refuses before any tap', async () => {
    setVaultChainLookup({
      ...fakeChainLookup(chain),
      markerHistory: async () => {
        throw new Error('socket hang up')
      }
    })
    const createAction = jest.spyOn(wallet, 'createAction')
    const err = await depositToVault(wallet, ADMIN, 250_000).then(
      () => null,
      e => e
    )
    expect(err).toBeInstanceOf(VaultError)
    expect(err.code).toBe('lookup-unknown')
    expect(err.details).toEqual({ reason: 'request-failed', index: 1 })
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(createAction).not.toHaveBeenCalled()
  })

  it('unknown with rows (window-full) counts as used and skips', async () => {
    const lookup: VaultChainLookup = {
      ...fakeChainLookup(chain),
      markerHistory: async script => {
        if (script === (await markerHex(wallet, 1))) {
          return { status: 'unknown', reason: 'window-full', txids: ['aa'.repeat(32)] }
        }
        return { status: 'none' }
      }
    }
    setVaultChainLookup(lookup)
    const dep = await depositToVault(wallet, ADMIN, 250_000)
    expect(await markerIndexesIn(wallet, chain, dep.txid)).toEqual([2])
  })

  it('probe limit: 70 consecutive used indexes reject with probe-limit', async () => {
    const found: MarkerHistory = { status: 'found', txids: ['bb'.repeat(32)] }
    const calls: string[] = []
    setVaultChainLookup({
      ...fakeChainLookup(chain),
      markerHistory: async script => {
        calls.push(script)
        return found
      }
    })
    const err = await depositToVault(wallet, ADMIN, 250_000).then(
      () => null,
      e => e
    )
    expect(err).toBeInstanceOf(VaultError)
    expect(err.code).toBe('lookup-unknown')
    expect(err.details?.reason).toBe('probe-limit')
    expect(calls).toHaveLength(64)
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('an unconfirmed marker (history from the unconfirmed endpoint) counts as used', async () => {
    const dustTxid = await publishDust(wallet, chain, 1, false)
    expect(chain.isConfirmed(dustTxid)).toBe(false)
    const dep = await depositToVault(wallet, ADMIN, 250_000)
    expect(await markerIndexesIn(wallet, chain, dep.txid)).toEqual([2])
  })

  it('remainder and re-lock use the same allocation', async () => {
    await depositToVault(wallet, ADMIN, 250_000) // index 1
    await publishDust(wallet, chain, 2)
    const part = await withdrawFromVault(wallet, ADMIN, 100_000, 'Withdraw part', keys[0].serial)
    expect(await markerIndexesIn(wallet, chain, part.txid)).toEqual([3])

    await publishDust(wallet, chain, 4)
    const relock = await relockVault(wallet, ADMIN, 'Re-lock', keys[0].serial)
    expect(await markerIndexesIn(wallet, chain, relock.txid)).toEqual([5])
  })
})
