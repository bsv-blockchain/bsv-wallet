/**
 * Hardening: the chain is checked before any YubiKey reset (audit finding
 * reset-new-phone; port of the audit scenario "restored phone, empty local
 * records, card already opens funds").
 *
 * The local guards in pivReset.ts read local data only, which is empty after a
 * restore. A reset needs either a clearance from checkVaultCardFunds (a
 * complete chain scan found no record naming the card) or the owner's explicit
 * acknowledgeFundsLoss. Mock wallet, mock chain and mock card: no network.
 */
import { Utils } from '@bsv/sdk'
import { PrivateKey } from '@bsv/sdk'
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

import { setMockDriver } from '../../core/services/vault/driver'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { resetPivApplication } from '../../core/services/vault/pivReset'
import { resetSaltFloors, type MarkerHistory, type VaultChainLookup } from '../../core/services/vault/markerLookup'
import {
  VAULT_RESET_CLEARANCE_MS,
  checkVaultCardFunds,
  isValidResetClearance,
  type VaultResetClearance
} from '../../core/services/vault/setupGate'
import { vaultStore, type VaultKeyRecord } from '../../core/services/vault/vaultStore'
import { FakeChain, FakeVaultWallet, fakeChainLookup } from './testSupport/fakeVaultChain'
import { ADMIN, CHAIN, newMember, publishVaultTx } from './testSupport/publishVault'

jest.setTimeout(120_000)

const SERIAL = 'MOCK-RST'
const OTHER_SERIAL = 'MOCK-OTHER'
const IDENTITY = `02${'55'.repeat(32)}`
const OTHER_IDENTITY = `03${'66'.repeat(32)}`

// The card's key list entry, and a second key that is not the card.
const CARD = { ...newMember('Card', 1), serial: SERIAL }
const OTHER_KEY = newMember('Other', 2)
const KEYS = [CARD, OTHER_KEY]

describe('hardening: reset gate (reset-new-phone)', () => {
  const primaryKey = new PrivateKey(9876).toArray()
  let chain: FakeChain
  let wallet: FakeVaultWallet
  let mock: MockYubiKey
  let resetSpy: jest.SpyInstance

  beforeEach(() => {
    chain = new FakeChain()
    wallet = new FakeVaultWallet(primaryKey, chain)
    ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
    vaultStore.clearScope()
    vaultStore.configureScope({ identityKey: IDENTITY, chain: CHAIN })
    resetSaltFloors()
    mock = new MockYubiKey()
    mock.insertKey(SERIAL)
    setMockDriver(mock)
    resetSpy = jest.spyOn(mock, 'resetPivApplication')
  })

  afterEach(() => {
    setMockDriver(null)
    vaultStore.clearScope()
    jest.restoreAllMocks()
  })

  const check = (lookup: VaultChainLookup = fakeChainLookup(chain), serial = SERIAL) =>
    checkVaultCardFunds(wallet, ADMIN, lookup, CHAIN, serial)

  const reset = (extra: { fundsClearance?: VaultResetClearance; acknowledgeFundsLoss?: true } = {}) =>
    resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true, ...extra })

  const clearanceOf = async (): Promise<VaultResetClearance> => {
    const result = await check()
    if (result.kind !== 'clear') throw new Error(`expected clear, got ${result.kind}`)
    return result.clearance
  }

  it('reset-new-phone PoC: on a phone with no local vault record, resetPivApplication without a clearance refuses with chain-check-required and never touches the card', async () => {
    // The deposit exists on chain; this phone knows nothing about it.
    await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    expect(await vaultStore.getMeta()).toBeNull()
    const start = jest.spyOn(mock, 'start')
    const info = jest.spyOn(mock, 'getKeyInfo')

    await expect(reset()).rejects.toMatchObject({ code: 'chain-check-required' })
    expect(resetSpy).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
  })

  it("a deposit naming the card's serial makes checkVaultCardFunds return funds with the deposit count and satoshis, and no clearance exists to reset with", async () => {
    await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    await publishVaultTx(wallet, chain, 2, KEYS, 150_000)

    const result = await check()
    expect(result.kind).toBe('funds')
    if (result.kind !== 'funds') return
    expect(result.serial).toBe(SERIAL)
    expect(result.deposits).toBe(2)
    expect(result.satoshis).toBe(450_000)
    expect(result.vaults).toHaveLength(1)
    expect(result.vaults[0].satoshis).toBe(450_000)
    expect('clearance' in result).toBe(false)
    await expect(reset()).rejects.toMatchObject({ code: 'chain-check-required' })
    expect(resetSpy).not.toHaveBeenCalled()
  })

  it('a pending (unconfirmed) deposit naming the serial counts as funds with 0 sat known', async () => {
    await publishVaultTx(wallet, chain, 1, KEYS, 300_000, { confirmed: false })
    const result = await check()
    expect(result).toMatchObject({ kind: 'funds', deposits: 1, satoshis: 0 })
  })

  it('no deposit names the serial: clear, and a reset with that clearance proceeds', async () => {
    const result = await check()
    expect(result.kind).toBe('clear')
    if (result.kind !== 'clear') return
    await reset({ fundsClearance: result.clearance })
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(resetSpy).toHaveBeenCalledWith(SERIAL)
  })

  describe('a clearance is bound to the card, the wallet scope, the clock and its issuer', () => {
    it('a different serial is refused', async () => {
      const clearance = await clearanceOf()
      const storageKey = vaultStore.captureScopeToken().storageKey
      expect(isValidResetClearance(clearance, SERIAL, storageKey)).toBe(true)
      expect(isValidResetClearance(clearance, OTHER_SERIAL, storageKey)).toBe(false)
      mock.insertKey(OTHER_SERIAL)
      await expect(
        resetPivApplication({
          serial: OTHER_SERIAL,
          acknowledgeDestroysAllCredentials: true,
          fundsClearance: clearance
        })
      ).rejects.toMatchObject({ code: 'chain-check-required' })
      expect(resetSpy).not.toHaveBeenCalled()
    })

    it('an expired clearance (now + 11 minutes) is refused, and 10 minutes still passes', async () => {
      const clearance = await clearanceOf()
      const storageKey = vaultStore.captureScopeToken().storageKey
      const now = clearance.issuedAt
      expect(isValidResetClearance(clearance, SERIAL, storageKey, now + VAULT_RESET_CLEARANCE_MS)).toBe(true)
      expect(isValidResetClearance(clearance, SERIAL, storageKey, now + 11 * 60 * 1000)).toBe(false)
      jest.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000)
      await expect(reset({ fundsClearance: clearance })).rejects.toMatchObject({ code: 'chain-check-required' })
      expect(resetSpy).not.toHaveBeenCalled()
    })

    it('a clearance for another wallet scope is refused', async () => {
      const clearance = await clearanceOf()
      vaultStore.configureScope({ identityKey: OTHER_IDENTITY, chain: CHAIN })
      await expect(reset({ fundsClearance: clearance })).rejects.toMatchObject({ code: 'chain-check-required' })
      expect(resetSpy).not.toHaveBeenCalled()
    })

    it('a hand-made clearance object is refused', async () => {
      const storageKey = vaultStore.captureScopeToken().storageKey
      const forged: VaultResetClearance = { serial: SERIAL, storageKey, issuedAt: Date.now() }
      expect(isValidResetClearance(forged, SERIAL, storageKey)).toBe(false)
      await expect(reset({ fundsClearance: forged })).rejects.toMatchObject({ code: 'chain-check-required' })
      // A copy of a real clearance is a different object, so it is refused too.
      const copy = { ...(await clearanceOf()) }
      expect(isValidResetClearance(copy, SERIAL, storageKey)).toBe(false)
      expect(isValidResetClearance(undefined, SERIAL, storageKey)).toBe(false)
      expect(resetSpy).not.toHaveBeenCalled()
    })
  })

  it('lookup failure (every markerHistory unknown) gives unknown and reset refuses; with acknowledgeFundsLoss it proceeds', async () => {
    const down: VaultChainLookup = {
      ...fakeChainLookup(chain),
      markerHistory: async (): Promise<MarkerHistory> => ({ status: 'unknown', reason: 'request-failed', txids: [] })
    }
    const result = await check(down)
    expect(result.kind).toBe('unknown')
    if (result.kind !== 'unknown') return
    expect(result.reason).toBe('chain-scan-failed')
    expect('clearance' in result).toBe(false)

    await expect(reset()).rejects.toMatchObject({ code: 'chain-check-required' })
    expect(resetSpy).not.toHaveBeenCalled()
    await reset({ acknowledgeFundsLoss: true })
    expect(resetSpy).toHaveBeenCalledTimes(1)
  })

  it('funds found and acknowledgeFundsLoss: true still resets (the owner allows it on explicit affirmation)', async () => {
    await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    expect((await check()).kind).toBe('funds')
    await reset({ acknowledgeFundsLoss: true })
    expect(resetSpy).toHaveBeenCalledTimes(1)
  })

  it("an unrelated card (another serial in the same wallet's deposits) is clear", async () => {
    await publishVaultTx(wallet, chain, 1, [OTHER_KEY, newMember('Third', 3)], 300_000)
    expect((await check()).kind).toBe('clear')
  })

  it('a spent-only history (all deposits withdrawn) is clear', async () => {
    await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    await publishVaultTx(wallet, chain, 2, KEYS, 200_000)
    const spent: VaultChainLookup = { ...fakeChainLookup(chain), outputStatus: async () => 'spent' }
    const result = await check(spent)
    expect(result.kind).toBe('clear')
  })

  it('spent-output status unknown gives unknown (problem), not clear', async () => {
    await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    const blind: VaultChainLookup = { ...fakeChainLookup(chain), outputStatus: async () => 'unknown' }
    const result = await check(blind)
    expect(result.kind).toBe('unknown')
    if (result.kind !== 'unknown') return
    expect(result.problems).toBe(1)
    expect(result.reason).toBe('could not confirm the vault output is unspent')
  })

  it('existing guards still win: a locally enrolled serial refuses with key-already-enrolled even with acknowledgeFundsLoss', async () => {
    const record: VaultKeyRecord = {
      serial: SERIAL,
      slot: 0x82,
      pubkey: Utils.toHex(Array.from(p256.Point.BASE.multiply(BigInt(7)).toBytes(true))),
      nickname: 'Key 7',
      enrolledAt: 1_700_000_000_007
    }
    const other: VaultKeyRecord = { ...record, serial: OTHER_SERIAL, nickname: 'Key 8', pubkey: CARD.pubkey }
    await vaultStore.setMeta({ v: 6, vaultId: '11'.repeat(32), revision: 1, createdAt: 1, keys: [record, other] })

    await expect(reset({ acknowledgeFundsLoss: true })).rejects.toMatchObject({ code: 'key-already-enrolled' })
    const clearance = await clearanceOf()
    await expect(reset({ fundsClearance: clearance })).rejects.toMatchObject({ code: 'key-already-enrolled' })
    expect(resetSpy).not.toHaveBeenCalled()
  })
})
