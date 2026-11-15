/**
 * Hardening: tap-only restore (audit finding planted-lockout; rules R1 and R2).
 *
 * A scan with no tapped key only REPORTS what the chain holds (`needsKey`): it
 * never internalizes an output and never writes vault metadata, unless this
 * phone already holds a vault with a checked key. A tapped restore
 * (recoverVaultWithKey, recoverVaultFromTxidsWithKey) restores, and marks the
 * tapped key checked whenever the stored meta holds it.
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

import { requestVaultSigner } from '../../core/services/vault/ceremonyHost'
import {
  recoverVaultFromChain,
  recoverVaultFromTxids,
  recoverVaultFromTxidsWithKey,
  recoverVaultWithKey,
  scanVaultDeposits
} from '../../core/services/vault/chainRecovery'
import { resetSaltFloors, type MarkerHistory, type VaultChainLookup } from '../../core/services/vault/markerLookup'
import type { VaultInstructionKey, VaultInstructionsV7 } from '../../core/services/vault/r1comb'
import { deriveVaultMarkerScript, withdrawFromVault } from '../../core/services/vault/transfers'
import { VaultError } from '../../core/services/vault/types'
import { vaultStore } from '../../core/services/vault/vaultStore'
import { FakeChain, FakeVaultWallet, fakeChainLookup } from './testSupport/fakeVaultChain'
import { ADMIN, CHAIN, VAULT_ID, newMember, publishVaultTx } from './testSupport/publishVault'
import { restoreNothingAdopted, tapRestore } from './testSupport/tapRestore'
import { armSigner, buildKeyring, seedOwnMeta } from './testSupport/vaultHarness'
import type { MockYubiKey } from '../../core/services/vault/mockYubiKey'

jest.setTimeout(300_000)

const SCOPE_IDENTITY = `02${'55'.repeat(32)}`
const OTHER_VAULT_ID = 'cd'.repeat(32)

async function markerHex(w: FakeVaultWallet, index: number): Promise<string> {
  return (await deriveVaultMarkerScript(w, ADMIN, CHAIN, String(index))).toHex()
}

/** A transaction that pays 1 sat to the marker script of `index` and is not a vault transaction. */
async function publishMarkerDust(w: FakeVaultWallet, chain: FakeChain, index: number, n: number): Promise<string> {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(await markerHex(w, index)) })
  tx.addOutput({ satoshis: 1000 + n, lockingScript: new P2PKH().lock(Utils.toArray('d1'.repeat(20), 'hex')) })
  return chain.publish(tx)
}

describe('hardening: a restore needs a tapped key (planted-lockout)', () => {
  const primaryKey = new PrivateKey(8642).toArray()
  let chain: FakeChain
  let wallet: FakeVaultWallet
  let mock: MockYubiKey
  let A: VaultInstructionKey
  let B: VaultInstructionKey
  const X = newMember('X', 11)
  const Y = newMember('Y', 12)

  beforeAll(async () => {
    const keyring = await buildKeyring(3)
    mock = keyring.mock
    ;[A, B] = keyring.keys
  })

  beforeEach(() => {
    chain = new FakeChain()
    wallet = new FakeVaultWallet(primaryKey, chain)
    ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
    vaultStore.clearScope()
    vaultStore.configureScope({ identityKey: SCOPE_IDENTITY, chain: CHAIN })
    resetSaltFloors()
    ;(requestVaultSigner as jest.Mock).mockReset()
  })

  const lookup = () => fakeChainLookup(chain)
  const pubkeys = (keys: readonly { pubkey: string }[]): string[] => keys.map(k => k.pubkey)

  async function withdrawAllWithA(): Promise<void> {
    armSigner(mock, A.serial)
    const result = await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw', A.serial)
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/)
    expect(wallet.localVaultOutpoints()).toEqual([])
  }

  /** `unknown` at marker index 1 with the given rows, as a window-full indexer answers. */
  function unknownAtIndex1(marker1: string, txids: string[]): VaultChainLookup {
    const base = lookup()
    return {
      ...base,
      markerHistory: async (hexScript): Promise<MarkerHistory> => {
        if (hexScript === marker1) return { status: 'unknown', reason: 'request-failed', txids }
        const rows = await base.transactionsForLockingScript(hexScript)
        return rows.length === 0 ? { status: 'none' } : { status: 'found', txids: rows }
      }
    }
  }

  async function expectNothingRestored(): Promise<void> {
    expect(wallet.hasLocalVaultOutputs()).toBe(false)
    expect(await vaultStore.getMeta()).toBeNull()
  }

  async function expectReportOnly(result: Awaited<ReturnType<typeof scanVaultDeposits>>): Promise<void> {
    expect(result).toMatchObject({
      found: 0,
      needsKey: true,
      conflict: false,
      status: 'complete',
      pendingConfirmation: 0,
      unreachable: 0
    })
    expect(result.groups).toHaveLength(1)
    expect(result.groups![0]).toMatchObject({ satoshis: 300_000, outputs: 1 })
    expect(result.setApart).toEqual(result.groups)
    await expectNothingRestored()
  }

  it('R2: a scan with the mnemonic alone restores nothing', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    await expectReportOnly(await scanVaultDeposits(wallet, ADMIN, lookup(), CHAIN))
    armSigner(mock, A.serial)
    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw', A.serial)).rejects.toMatchObject({
      code: 'not-enrolled'
    })
  })

  it('recoverVaultFromChain is the same report', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    await expectReportOnly(await recoverVaultFromChain(wallet, ADMIN, lookup(), CHAIN))
    armSigner(mock, A.serial)
    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw', A.serial)).rejects.toMatchObject({
      code: 'not-enrolled'
    })
  })

  it('recoverVaultFromTxids with the real txid is report-only', async () => {
    const real = await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    const result = await recoverVaultFromTxids(wallet, ADMIN, lookup(), CHAIN, [real.txid])
    expect(result).toMatchObject({ found: 0, needsKey: true })
    await expectNothingRestored()
  })

  it('a vault with only an unconfirmed deposit still needs a key', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000, { confirmed: false })
    const result = await scanVaultDeposits(wallet, ADMIN, lookup(), CHAIN)
    expect(result).toMatchObject({ needsKey: true, pendingConfirmation: 1, found: 0 })
    expect(result.groups).toHaveLength(1)
    expect(result.groups![0]).toMatchObject({ outputs: 0, satoshis: 0 })
    await expectNothingRestored()
  })

  it('two lineages are a conflict and still need a key', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    await publishVaultTx(wallet, chain, 2, [X, Y], 300_000, { vaultId: OTHER_VAULT_ID, createdAt: 5 })
    const result = await scanVaultDeposits(wallet, ADMIN, lookup(), CHAIN)
    expect(result).toMatchObject({ needsKey: true, conflict: true, found: 0 })
    expect(result.groups).toHaveLength(2)
    await expectNothingRestored()
  })

  it('an empty complete chain says none: needsKey is false', async () => {
    const result = await scanVaultDeposits(wallet, ADMIN, lookup(), CHAIN)
    expect(result).toMatchObject({ needsKey: false, status: 'complete', found: 0 })
    expect(result.groups).toEqual([])
  })

  it('an unknown index with nothing read is incomplete, not none', async () => {
    const result = await scanVaultDeposits(wallet, ADMIN, unknownAtIndex1(await markerHex(wallet, 1), []), CHAIN)
    expect(result).toMatchObject({ status: 'incomplete', unknownIndexes: [1], needsKey: false, found: 0 })
  })

  it('R1 walk 1: mnemonic + one key restores with one tap', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    await expectReportOnly(await scanVaultDeposits(wallet, ADMIN, lookup(), CHAIN))
    const result = await tapRestore(wallet, lookup(), CHAIN, A)
    expect(result).toMatchObject({ found: 1, conflict: false })
    expect(result.key).toEqual(A)
    const meta = (await vaultStore.getMeta())!
    expect(pubkeys(meta.keys)).toEqual(pubkeys([A, B]))
    expect(vaultStore.provenKeyRecords(meta).map(k => k.serial)).toEqual([A.serial])
    await withdrawAllWithA()
  })

  it('R1 walk 2(i): scan incomplete, the real deposit among the rows read', async () => {
    const real = await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    const partial = unknownAtIndex1(await markerHex(wallet, 1), [real.txid])
    const result = await tapRestore(wallet, partial, CHAIN, A)
    expect(result).toMatchObject({ found: 1, status: 'incomplete', unknownIndexes: [1] })
    await withdrawAllWithA()

    await publishVaultTx(wallet, chain, 2, [A, B], 200_000)
    const later = await scanVaultDeposits(wallet, ADMIN, lookup(), CHAIN)
    expect(later).toMatchObject({ needsKey: false, found: 1 })
  })

  it('R1 walk 2(ii)+4: real deposit unreadable (dust fills the window) - a tapped scan opens nothing, the txid path restores with one tap', async () => {
    const dust: string[] = []
    for (let n = 0; n < 3; n++) dust.push(await publishMarkerDust(wallet, chain, 1, n))
    const real = await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    const blocked = unknownAtIndex1(await markerHex(wallet, 1), dust)

    // A callback that returns the key whatever it is shown restores nothing: no record is in the scan. (The
    // real card throws key-opens-nothing here; the strict callback below does the same.)
    expect(await tapRestore(wallet, blocked, CHAIN, A)).toMatchObject({ found: 0, status: 'incomplete' })
    await expectNothingRestored()
    // The card is replaced by a callback that, like the real one, throws when no record names the key.
    const strictProve = async (records: readonly VaultInstructionsV7[]) => {
      if (records.length === 0) throw new VaultError('key-opens-nothing', 'No record names this key')
      return A
    }
    await expect(recoverVaultWithKey(wallet, ADMIN, blocked, CHAIN, strictProve)).rejects.toMatchObject({
      code: 'key-opens-nothing'
    })
    await expectNothingRestored()

    const result = await recoverVaultFromTxidsWithKey(wallet, ADMIN, blocked, CHAIN, [real.txid], async () => A)
    expect(result.found).toBe(1)
    expect(result.key).toEqual(A)
    await withdrawAllWithA()
  })

  it('R1 walk 3(i): the planted lineage holds other keys: one tap', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    await publishVaultTx(wallet, chain, 2, [X, Y], 300_000, { vaultId: OTHER_VAULT_ID, createdAt: 5 })
    const result = await tapRestore(wallet, lookup(), CHAIN, A)
    expect(result).toMatchObject({ found: 1, conflict: false })
    expect(pubkeys((await vaultStore.getMeta())!.keys)).toEqual(pubkeys([A, B]))
    await withdrawAllWithA()
  })

  it('R1 walk 3(ii): two groups hold the tapped key: first tap reports conflict, the second restores', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    await publishVaultTx(wallet, chain, 2, [A, X], 300_000, { vaultId: OTHER_VAULT_ID, createdAt: 5 })
    let proveCalls = 0
    const prove = async () => {
      proveCalls++
      return A
    }
    const first = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, prove)
    expect(first).toMatchObject({ conflict: true, found: 0 })
    expect(first.setApart).toHaveLength(2)
    expect(await vaultStore.getMeta()).toBeNull()

    const real = first.setApart!.find(g => g.keys[1].pubkey === B.pubkey)!
    const second = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, prove, undefined, { groupId: real.id })
    expect(second.found).toBe(1)
    expect(proveCalls).toBe(2) // documents the two-tap case
    expect(pubkeys((await vaultStore.getMeta())!.keys)).toEqual(pubkeys([A, B]))
  })

  it('a scan merges into a vault enrolled on this phone with no tap', async () => {
    await seedOwnMeta(wallet, { v: 6, vaultId: VAULT_ID, revision: 1, createdAt: 1, keys: [A, B] })
    const real = await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    const result = await scanVaultDeposits(wallet, ADMIN, lookup(), CHAIN)
    expect(result).toMatchObject({ found: 1, needsKey: false })
    expect(wallet.localVaultOutpoints()).toContain(`${real.txid}.0`)
  })

  it('existing meta with no proven key: a scan only reports', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    await restoreNothingAdopted(wallet, lookup(), CHAIN, A)
    expect(vaultStore.provenKeyRecords((await vaultStore.getMeta())!)).toEqual([])
    await publishVaultTx(wallet, chain, 2, [A, B], 200_000)
    const metaBefore = await vaultStore.getMeta()
    const outpointsBefore = wallet.localVaultOutpoints()

    const result = await scanVaultDeposits(wallet, ADMIN, lookup(), CHAIN)
    expect(result).toMatchObject({ found: 0, needsKey: true })
    expect(await vaultStore.getMeta()).toEqual(metaBefore)
    expect(wallet.localVaultOutpoints()).toEqual(outpointsBefore)
  })

  it('a tap over that meta proves the key although nothing new was internalized', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    await restoreNothingAdopted(wallet, lookup(), CHAIN, A)
    expect(vaultStore.provenKeyRecords((await vaultStore.getMeta())!)).toEqual([])

    const result = await tapRestore(wallet, lookup(), CHAIN, A)
    expect(result.found).toBe(0)
    const meta = (await vaultStore.getMeta())!
    expect(vaultStore.provenKeyRecords(meta).map(k => k.serial)).toEqual([A.serial])
    expect(meta.recovery?.adopted).toEqual(expect.arrayContaining([expect.objectContaining({ pubkey: A.pubkey })]))

    await publishVaultTx(wallet, chain, 2, [A, B], 200_000)
    const later = await scanVaultDeposits(wallet, ADMIN, lookup(), CHAIN)
    expect(later).toMatchObject({ found: 1, needsKey: false })
  })

  it('a tap over a vault enrolled on this phone keeps every key proven', async () => {
    await seedOwnMeta(wallet, { v: 6, vaultId: VAULT_ID, revision: 1, createdAt: 1, keys: [A, B] })
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    const result = await tapRestore(wallet, lookup(), CHAIN, A)
    expect(result.found).toBe(1)
    const meta = (await vaultStore.getMeta())!
    expect(meta.recovery).toBeUndefined()
    expect(vaultStore.provenKeyRecords(meta).map(k => k.serial)).toEqual([A.serial, B.serial])
  })

  it('recoverVaultFromTxidsWithKey: a transaction with no vault record never presents the card', async () => {
    const plain = new Transaction()
    plain.addOutput({ satoshis: 5000, lockingScript: new P2PKH().lock(Utils.toArray('d4'.repeat(20), 'hex')) })
    const plainTxid = chain.publish(plain)
    const prove = jest.fn()
    const result = await recoverVaultFromTxidsWithKey(wallet, ADMIN, lookup(), CHAIN, [plainTxid], prove)
    expect(prove).not.toHaveBeenCalled()
    expect(result.key).toBeUndefined()
    expect(result.found).toBe(0)
    expect(result.problems).toHaveLength(1)
    await expectNothingRestored()
  })

  it('recoverVaultFromTxidsWithKey: a 1-sat copy is ignored', async () => {
    const copy = await publishVaultTx(wallet, chain, 1, [A, B], 1)
    const prove = jest.fn()
    const result = await recoverVaultFromTxidsWithKey(wallet, ADMIN, lookup(), CHAIN, [copy.txid], prove)
    expect(prove).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ignoredBelowMinimum: 1, found: 0 })
    expect(result.key).toBeUndefined()
    await expectNothingRestored()
  })

  it('recoverVaultFromTxidsWithKey: a planted record naming only another key opens nothing for a real key', async () => {
    const planted = await publishVaultTx(wallet, chain, 1, [X, Y], 300_000, { vaultId: OTHER_VAULT_ID, createdAt: 5 })
    const prove = async (records: readonly VaultInstructionsV7[]) => {
      if (!records.some(r => r.keys.some(k => k.pubkey === A.pubkey))) {
        throw new VaultError('key-opens-nothing', 'No record names this key')
      }
      return A
    }
    await expect(
      recoverVaultFromTxidsWithKey(wallet, ADMIN, lookup(), CHAIN, [planted.txid], prove)
    ).rejects.toMatchObject({ code: 'key-opens-nothing' })
    await expectNothingRestored()
  })

  it('recoverVaultFromTxidsWithKey keeps the txid argument checks', async () => {
    const prove = jest.fn()
    const good = 'ab'.repeat(32)
    const many = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(64, '0'))
    const code = { code: 'template-invalid' }
    await expect(recoverVaultFromTxidsWithKey(wallet, ADMIN, lookup(), CHAIN, many, prove)).rejects.toMatchObject(code)
    await expect(recoverVaultFromTxidsWithKey(wallet, ADMIN, lookup(), CHAIN, ['zz'], prove)).rejects.toMatchObject(
      code
    )
    await expect(recoverVaultFromTxidsWithKey(wallet, ADMIN, lookup(), CHAIN, [good], prove, 0)).rejects.toMatchObject(
      code
    )
    await expect(
      recoverVaultFromTxidsWithKey(wallet, ADMIN, lookup(), CHAIN, [good], prove, 1001)
    ).rejects.toMatchObject(code)
    expect(prove).not.toHaveBeenCalled()
  })

  it('tapRestore helper: restoreNothingAdopted leaves provenKeyRecords empty', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    await restoreNothingAdopted(wallet, lookup(), CHAIN, A)
    expect(vaultStore.provenKeyRecords((await vaultStore.getMeta())!)).toEqual([])
    expect(wallet.hasLocalVaultOutputs()).toBe(true)
  })
})
