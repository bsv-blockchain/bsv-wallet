/**
 * Hardening: the scan collects every candidate, ignores outputs under the
 * floor and reports its problems (audit findings scan-shadow, scan-silent,
 * no-rescan and decoy-wedge part 1; ports of audit PoCs
 * critic/plant_scan_poc.cjs, verify-recovery/poc3_shadow.cjs and
 * critic/wedge_poc.cjs).
 *
 * The marker address of a deposit is public once the deposit confirms. A
 * stranger can pay it 1 sat or copy the whole record. The old scan stopped at
 * the first valid candidate and at 50 candidates, so such rows could hide the
 * real deposit. Now every row is examined, outputs under VAULT_SCAN_MIN_SATS
 * are counted and left out, and an index whose lookup is incomplete is
 * reported (never silently read as "no funds").
 */
import { LockingScript, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk'

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

import { scanVaultDeposits, recoverVaultFromChain } from '../../core/services/vault/chainRecovery'
import {
  resetSaltFloors,
  saltFloorFor,
  VAULT_SCAN_MIN_SATS,
  type MarkerHistory,
  type VaultChainLookup
} from '../../core/services/vault/markerLookup'
import { computeVaultMetaAuthorityTag } from '../../core/services/vault/metaAuthority'
import { VAULT_DEPOSIT_MIN, deriveVaultMarkerScript } from '../../core/services/vault/transfers'
import { vaultStore } from '../../core/services/vault/vaultStore'
import { FakeChain, FakeVaultWallet, fakeChainLookup } from './testSupport/fakeVaultChain'
import { ADMIN, CHAIN, VAULT_ID, newMember, publishVaultTx } from './testSupport/publishVault'

jest.setTimeout(120_000)

const SCOPE_IDENTITY = `02${'44'.repeat(32)}`
const KEYS = [newMember('Primary', 1), newMember('Backup', 2)]

async function markerHex(w: FakeVaultWallet, index: number): Promise<string> {
  return (await deriveVaultMarkerScript(w, ADMIN, CHAIN, String(index))).toHex()
}

/** A transaction that pays 1 sat to the marker script of `index` and is not a
 * vault transaction. `n` makes each one a different transaction. */
async function publishMarkerDust(w: FakeVaultWallet, chain: FakeChain, index: number, n: number): Promise<string> {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(await markerHex(w, index)) })
  tx.addOutput({ satoshis: 1000 + n, lockingScript: new P2PKH().lock(Utils.toArray('d1'.repeat(20), 'hex')) })
  return chain.publish(tx)
}

describe('hardening: scan collects every candidate (scan-shadow, scan-silent, no-rescan, decoy-wedge part 1)', () => {
  const primaryKey = new PrivateKey(4321).toArray()
  let chain: FakeChain
  let wallet: FakeVaultWallet

  beforeEach(() => {
    chain = new FakeChain()
    wallet = new FakeVaultWallet(primaryKey, chain)
    ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
    vaultStore.clearScope()
    vaultStore.configureScope({ identityKey: SCOPE_IDENTITY, chain: CHAIN })
    resetSaltFloors()
  })

  async function seedLocalMeta(): Promise<void> {
    const scope = vaultStore.getScope()!
    await vaultStore.setMeta({ v: 6, vaultId: VAULT_ID, revision: 1, createdAt: 1, keys: KEYS }, undefined, next =>
      computeVaultMetaAuthorityTag(wallet, ADMIN, next, scope)
    )
  }

  describe('scan-shadow PoC', () => {
    // The marker history is a set. Both orders matter: whichever row comes
    // first must not decide the result.
    it.each([['oldest first', false] as const, ['newest first', true] as const])(
      'scan-shadow PoC: a 1-sat copy published after a real 500,000-sat deposit does not hide it (%s)',
      async (_name, reversed) => {
        const real = await publishVaultTx(wallet, chain, 1, KEYS, 500_000)
        const copy = await publishVaultTx(wallet, chain, 1, KEYS, 1)
        expect(copy.txid).not.toBe(real.txid)
        const base = fakeChainLookup(chain)
        // The scan reads rows through lookupMarker, which prefers markerHistory
        // when a lookup has one. The fake has none, so the reversal below is
        // the only path rows take; guard that, so the reversed case cannot go
        // vacuous if the fake ever grows a markerHistory.
        expect(base.markerHistory).toBeUndefined()
        let reversedCalls = 0
        const lookup: VaultChainLookup = {
          ...base,
          transactionsForLockingScript: async hexScript => {
            const rows = await base.transactionsForLockingScript(hexScript)
            if (rows.length > 1) reversedCalls++
            return reversed ? [...rows].reverse() : rows
          }
        }

        const result = await scanVaultDeposits(wallet, ADMIN, lookup, CHAIN)
        expect(reversedCalls).toBe(1)
        expect(result.found).toBe(1)
        expect(result.ignoredBelowMinimum).toBe(1)
        expect(wallet.localVaultOutpoints()).toEqual([`${real.txid}.0`])
      }
    )
  })

  it('55 dust payments to the marker address do not hide the real deposit', async () => {
    for (let n = 0; n < 55; n++) await publishMarkerDust(wallet, chain, 1, n)
    const real = await publishVaultTx(wallet, chain, 1, KEYS, 300_000)

    const result = await scanVaultDeposits(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result.found).toBe(1)
    expect(wallet.localVaultOutpoints()).toEqual([`${real.txid}.0`])
    // The dust rows are counted as noise, never as problems: a stranger who
    // pays a public marker address must not keep every later scan 'incomplete'.
    expect(result.ignoredNonVault).toBe(55)
    expect(result.problemCount).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.status).toBe('complete')
  })

  it('a marker payment whose neighbour is not a v7 descriptor is noise, not a problem', async () => {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 200_000, lockingScript: new P2PKH().lock(Utils.toArray('d2'.repeat(20), 'hex')) })
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(await markerHex(wallet, 1)) })
    tx.addOutput({ satoshis: 5, lockingScript: new P2PKH().lock(Utils.toArray('d3'.repeat(20), 'hex')) })
    chain.publish(tx)
    const real = await publishVaultTx(wallet, chain, 1, KEYS, 300_000)

    const result = await scanVaultDeposits(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result.found).toBe(1)
    expect(wallet.localVaultOutpoints()).toEqual([`${real.txid}.0`])
    expect(result.ignoredNonVault).toBe(1)
    expect(result.problemCount).toBe(0)
    expect(result.status).toBe('complete')
  })

  it('a wallet-level decrypt failure is a problem, not noise: the scan is incomplete', async () => {
    await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    const realDecrypt = wallet.decrypt.bind(wallet)
    wallet.decrypt = async () => {
      throw new Error('wallet is locked')
    }
    try {
      const result = await scanVaultDeposits(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
      expect(result.found).toBe(0)
      expect(result.ignoredNonVault).toBe(0)
      expect(result.problemCount).toBe(1)
      expect(result.status).toBe('incomplete')
    } finally {
      wallet.decrypt = realDecrypt
    }
    // Positive control: once the wallet works, the same deposit is found.
    const again = await scanVaultDeposits(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(again.found).toBe(1)
    expect(again.status).toBe('complete')
  })

  it('a failed transaction fetch stays a problem and keeps the scan incomplete', async () => {
    const real = await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    const base = fakeChainLookup(chain)
    const lookup: VaultChainLookup = {
      ...base,
      transactionForTxid: async txid => (txid === real.txid ? null : base.transactionForTxid(txid))
    }
    const result = await scanVaultDeposits(wallet, ADMIN, lookup, CHAIN)
    expect(result.found).toBe(0)
    expect(result.ignoredNonVault).toBe(0)
    expect(result.problemCount).toBe(1)
    expect(result.status).toBe('incomplete')
  })

  it('a copy of 100,000 sat or more with the same keys is internalized as a second output', async () => {
    const real = await publishVaultTx(wallet, chain, 1, KEYS, 500_000)
    const copy = await publishVaultTx(wallet, chain, 1, KEYS, 100_000)

    const result = await scanVaultDeposits(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result.found).toBe(2)
    expect(result.ignoredBelowMinimum).toBe(0)
    expect(wallet.localVaultOutpoints()).toEqual([`${real.txid}.0`, `${copy.txid}.0`].sort())
  })

  it('outputs below VAULT_SCAN_MIN_SATS are never internalized and are counted', async () => {
    const real = await publishVaultTx(wallet, chain, 1, KEYS, 500_000)
    await publishVaultTx(wallet, chain, 1, KEYS, VAULT_SCAN_MIN_SATS - 1)

    const result = await scanVaultDeposits(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result.found).toBe(1)
    expect(result.ignoredBelowMinimum).toBe(1)
    expect(result.problems).toEqual([])
    expect(result.pendingConfirmation).toBe(0)
    expect(wallet.localVaultOutpoints()).toEqual([`${real.txid}.0`])
  })

  it('an unconfirmed output below the floor is counted as ignored, not pending', async () => {
    await publishVaultTx(wallet, chain, 1, KEYS, 1, { confirmed: false })
    const result = await scanVaultDeposits(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result).toMatchObject({ found: 0, ignoredBelowMinimum: 1, pendingConfirmation: 0, problemCount: 0 })
  })

  it('VAULT_DEPOSIT_MIN is not below VAULT_SCAN_MIN_SATS', () => {
    expect(VAULT_DEPOSIT_MIN).toBeGreaterThanOrEqual(VAULT_SCAN_MIN_SATS)
    // Message for a reader of a failure: lowering the deposit floor requires a new scan rule.
    if (VAULT_DEPOSIT_MIN < VAULT_SCAN_MIN_SATS) {
      throw new Error('lowering the deposit floor requires a new scan rule')
    }
  })

  it('an index whose lookup is unknown/window-full is reported, keeps its rows, and the status is incomplete', async () => {
    const real = await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    const marker1 = await markerHex(wallet, 1)
    const base = fakeChainLookup(chain)
    const lookup: VaultChainLookup = {
      ...base,
      markerHistory: async (hexScript): Promise<MarkerHistory> => {
        if (hexScript === marker1) return { status: 'unknown', reason: 'window-full', txids: [real.txid] }
        const rows = await base.transactionsForLockingScript(hexScript)
        return rows.length === 0 ? { status: 'none' } : { status: 'found', txids: rows }
      }
    }

    const result = await scanVaultDeposits(wallet, ADMIN, lookup, CHAIN)
    expect(result.found).toBe(1)
    expect(wallet.localVaultOutpoints()).toEqual([`${real.txid}.0`])
    expect(result.unknownIndexes).toEqual([1])
    expect(result.status).toBe('incomplete')
    expect(result.problemCount).toBe(result.problems.length)
    expect(result.problems[0].index).toBe(1)
    expect(result.problems[0].reason).toBe('lookup incomplete: window-full')
    expect(typeof result.problems[0].markerAddress).toBe('string')
  })

  it('a failed lookup at one index among three deposits reports it and the next scan completes', async () => {
    await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    await publishVaultTx(wallet, chain, 2, KEYS, 300_000)
    await publishVaultTx(wallet, chain, 3, KEYS, 300_000)
    const marker2 = await markerHex(wallet, 2)
    const base = fakeChainLookup(chain)
    let failed = false
    const flaky: VaultChainLookup = {
      ...base,
      transactionsForLockingScript: async hexScript => {
        if (hexScript === marker2 && !failed) {
          failed = true
          throw new Error('indexer unavailable')
        }
        return await base.transactionsForLockingScript(hexScript)
      }
    }

    const first = await scanVaultDeposits(wallet, ADMIN, flaky, CHAIN)
    expect(first.found).toBe(2)
    expect(first.status).toBe('incomplete')
    expect(first.unknownIndexes).toEqual([2])
    expect(wallet.localVaultOutpoints()).toHaveLength(2)

    // Same wallet, healthy lookup: merge by outpoint, only the missing one is new.
    const second = await scanVaultDeposits(wallet, ADMIN, flaky, CHAIN)
    expect(second.found).toBe(1)
    expect(second.status).toBe('complete')
    expect(second.unknownIndexes).toEqual([])
    expect(wallet.localVaultOutpoints()).toHaveLength(3)

    // A third run changes nothing.
    const third = await scanVaultDeposits(wallet, ADMIN, flaky, CHAIN)
    expect(third.found).toBe(0)
    expect(wallet.localVaultOutpoints()).toHaveLength(3)
  })

  it('scan with local meta present (no-rescan) finds a deposit made after the last backup', async () => {
    await seedLocalMeta()
    await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    expect((await scanVaultDeposits(wallet, ADMIN, fakeChainLookup(chain), CHAIN)).found).toBe(1)

    // Another phone with the same mnemonic deposits afterwards.
    const other = new FakeVaultWallet(primaryKey, chain)
    const later = await publishVaultTx(other, chain, 2, KEYS, 400_000)

    const result = await scanVaultDeposits(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result.found).toBe(1)
    expect(wallet.localVaultOutpoints()).toContain(`${later.txid}.0`)
    expect(wallet.localVaultOutpoints()).toHaveLength(2)
  })

  it('scan result for an empty chain: status complete, problemCount 0, maxUsedIndex 0', async () => {
    const result = await scanVaultDeposits(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result).toMatchObject({
      found: 0,
      unreachable: 0,
      pendingConfirmation: 0,
      ignoredBelowMinimum: 0,
      problems: [],
      problemCount: 0,
      unknownIndexes: [],
      maxUsedIndex: 0,
      status: 'complete'
    })
  })

  it('maxUsedIndex raises the salt floor hint', async () => {
    await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    await publishVaultTx(wallet, chain, 4, KEYS, 300_000)
    const storageKey = vaultStore.captureScopeToken().storageKey
    expect(saltFloorFor(storageKey)).toBe(0)

    const result = await scanVaultDeposits(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result.maxUsedIndex).toBe(4)
    expect(saltFloorFor(storageKey)).toBe(4)
  })

  it('recoverVaultFromChain is the same scan', async () => {
    const real = await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    const result = await recoverVaultFromChain(wallet, ADMIN, fakeChainLookup(chain), CHAIN)
    expect(result.found).toBe(1)
    expect(result.status).toBe('complete')
    expect(wallet.localVaultOutpoints()).toEqual([`${real.txid}.0`])
  })
})
