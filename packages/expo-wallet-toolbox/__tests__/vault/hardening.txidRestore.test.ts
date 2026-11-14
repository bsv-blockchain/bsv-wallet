/**
 * Hardening: restore from a transaction ID when the marker history is too
 * large to read (R1 exit for audit finding scan-shadow). No history window is
 * used, so dust at the marker address cannot hide a deposit. The app gets the
 * txid from the marker address shown in `problems[].markerAddress`.
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

import {
  scanVaultDeposits,
  recoverVaultFromTxids,
  recoverVaultFromTxidsWithKey
} from '../../core/services/vault/chainRecovery'
import { resetSaltFloors, type MarkerHistory, type VaultChainLookup } from '../../core/services/vault/markerLookup'
import { deriveVaultMarkerScript } from '../../core/services/vault/transfers'
import { vaultStore } from '../../core/services/vault/vaultStore'
import { FakeChain, FakeVaultWallet, fakeChainLookup } from './testSupport/fakeVaultChain'
import { ADMIN, CHAIN, newMember, publishVaultTx } from './testSupport/publishVault'

jest.setTimeout(120_000)

const SCOPE_IDENTITY = `02${'44'.repeat(32)}`
const KEYS = [newMember('Primary', 1), newMember('Backup', 2)]

async function markerHex(w: FakeVaultWallet, index: number): Promise<string> {
  return (await deriveVaultMarkerScript(w, ADMIN, CHAIN, String(index))).toHex()
}

async function publishMarkerDust(w: FakeVaultWallet, chain: FakeChain, index: number, n: number): Promise<string> {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(await markerHex(w, index)) })
  tx.addOutput({ satoshis: 1000 + n, lockingScript: new P2PKH().lock(Utils.toArray('d1'.repeat(20), 'hex')) })
  return chain.publish(tx)
}

describe('hardening: restore from a transaction ID (scan-shadow exit)', () => {
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

  it('with 1,200 dust rows at index 1 the history is unknown/window-full and a scan misses the real deposit, but recoverVaultFromTxids restores it from its txid', async () => {
    const dust: string[] = []
    for (let n = 0; n < 1200; n++) dust.push(await publishMarkerDust(wallet, chain, 1, n))
    const real = await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    const marker1 = await markerHex(wallet, 1)
    const base = fakeChainLookup(chain)
    const lookup: VaultChainLookup = {
      ...base,
      markerHistory: async (hexScript): Promise<MarkerHistory> => {
        if (hexScript === marker1) return { status: 'unknown', reason: 'window-full', txids: dust }
        const rows = await base.transactionsForLockingScript(hexScript)
        return rows.length === 0 ? { status: 'none' } : { status: 'found', txids: rows }
      }
    }

    const scan = await scanVaultDeposits(wallet, ADMIN, lookup, CHAIN)
    expect(scan.found).toBe(0)
    expect(scan.unknownIndexes).toEqual([1])
    expect(scan.status).toBe('incomplete')
    expect(wallet.localVaultOutpoints()).toEqual([])

    const result = await recoverVaultFromTxidsWithKey(
      wallet,
      ADMIN,
      lookup,
      CHAIN,
      [real.txid.toUpperCase()],
      async () => KEYS[0]
    )
    expect(result.found).toBe(1)
    expect(result.scanned).toBe(200)
    expect(result.problems).toEqual([])
    expect(result.status).toBe('complete')
    expect(result.maxUsedIndex).toBe(1)
    expect(wallet.localVaultOutpoints()).toEqual([`${real.txid}.0`])
  })

  it('maxIndex has an upper bound: a huge value throws a clear VaultError before any derivation', async () => {
    const lookup = fakeChainLookup(chain)
    const tx = 'ab'.repeat(32)
    for (const bad of [1001, 1_000_000_000, Number.MAX_SAFE_INTEGER]) {
      await expect(recoverVaultFromTxids(wallet, ADMIN, lookup, CHAIN, [tx], bad)).rejects.toMatchObject({
        code: 'template-invalid',
        message: expect.stringContaining('at most 1000')
      })
    }
  })

  it('a txid that is not a vault transaction reports a problem and internalizes nothing', async () => {
    const plain = new Transaction()
    plain.addOutput({ satoshis: 5000, lockingScript: new P2PKH().lock(Utils.toArray('d4'.repeat(20), 'hex')) })
    const plainTxid = chain.publish(plain)
    const dustTxid = await publishMarkerDust(wallet, chain, 1, 0)
    const lookup = fakeChainLookup(chain)

    const result = await recoverVaultFromTxids(wallet, ADMIN, lookup, CHAIN, [plainTxid])
    expect(result.found).toBe(0)
    expect(result.problems).toEqual([{ index: 0, reason: 'no vault marker found in this transaction' }])
    expect(result.status).toBe('incomplete')
    expect(wallet.localVaultOutpoints()).toEqual([])

    // A transaction that pays a marker but holds no vault record is also reported.
    const dustResult = await recoverVaultFromTxids(wallet, ADMIN, lookup, CHAIN, [dustTxid])
    expect(dustResult.found).toBe(0)
    expect(dustResult.problemCount).toBe(1)
    expect(dustResult.problems[0].index).toBe(1)
    expect(wallet.localVaultOutpoints()).toEqual([])
  })

  it('a txid the lookup cannot return is a problem', async () => {
    const real = await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    const base = fakeChainLookup(chain)
    const lookup: VaultChainLookup = { ...base, transactionForTxid: async () => null }
    const result = await recoverVaultFromTxids(wallet, ADMIN, lookup, CHAIN, [real.txid])
    expect(result.found).toBe(0)
    expect(result.problemCount).toBe(1)
    expect(result.status).toBe('incomplete')
  })

  it('a 1-sat copy given by txid is ignored (below the floor)', async () => {
    const copy = await publishVaultTx(wallet, chain, 1, KEYS, 1)
    const result = await recoverVaultFromTxids(wallet, ADMIN, fakeChainLookup(chain), CHAIN, [copy.txid])
    expect(result.found).toBe(0)
    expect(result.ignoredBelowMinimum).toBe(1)
    expect(result.problems).toEqual([])
    expect(wallet.localVaultOutpoints()).toEqual([])
  })

  it('51 txids is refused; a malformed txid is refused; maxIndex must be a positive integer', async () => {
    const lookup = fakeChainLookup(chain)
    const many = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(64, '0'))
    await expect(recoverVaultFromTxids(wallet, ADMIN, lookup, CHAIN, many)).rejects.toMatchObject({
      code: 'template-invalid'
    })
    await expect(recoverVaultFromTxids(wallet, ADMIN, lookup, CHAIN, many.slice(0, 50))).resolves.toMatchObject({
      found: 0
    })
    for (const bad of ['abc', 'zz'.repeat(32), `${'ab'.repeat(32)}00`]) {
      await expect(recoverVaultFromTxids(wallet, ADMIN, lookup, CHAIN, [bad])).rejects.toMatchObject({
        code: 'template-invalid'
      })
    }
    await expect(recoverVaultFromTxids(wallet, ADMIN, lookup, CHAIN, ['ab'.repeat(32)], 0)).rejects.toMatchObject({
      code: 'template-invalid'
    })
  })

  it('restoring the same txid twice is a no-op the second time (merge by outpoint)', async () => {
    const real = await publishVaultTx(wallet, chain, 1, KEYS, 300_000)
    const lookup = fakeChainLookup(chain)
    const first = await recoverVaultFromTxidsWithKey(wallet, ADMIN, lookup, CHAIN, [real.txid], async () => KEYS[0])
    expect(first.found).toBe(1)
    const second = await recoverVaultFromTxids(wallet, ADMIN, lookup, CHAIN, [real.txid, real.txid.toUpperCase()])
    expect(second.found).toBe(0)
    expect(second.problems).toEqual([])
    expect(wallet.localVaultOutpoints()).toEqual([`${real.txid}.0`])
  })
})
