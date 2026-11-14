/**
 * Hardening: a scan adds outputs only, sets conflicting records apart and keeps
 * a full withdrawal open (audit findings planted-lockout, decoy-wedge part 2 and
 * planted-key's restore half; ports of audit PoCs verify-authority/
 * planted_key_poc.cjs, critic/wedge_poc.cjs and recovery/poc*.cjs).
 *
 * The marker and descriptor derive from the wallet root, so anyone holding the
 * mnemonic can plant a record (any vaultId, revision or key list). The scan must
 * never let such a record hide a real deposit or make restore throw (R1), and
 * must never add a key, revision or removal to an existing local meta (R2). The
 * lock-set gate that stops a planted key from entering a new lock is Task 8.
 */
import { LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'

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
import { recoverVaultFromChain, recoverVaultWithKey, scanVaultDeposits } from '../../core/services/vault/chainRecovery'
import { resetSaltFloors } from '../../core/services/vault/markerLookup'
import type { VaultInstructionKey } from '../../core/services/vault/r1comb'
import {
  forgetVaultSetup,
  recoverVaultMetaFromOutputs,
  relockVault,
  withdrawFromVault
} from '../../core/services/vault/transfers'
import { metaFromVerifiedOutputs } from '../../core/services/vault/VaultKeyService'
import { vaultStore, type VaultMeta } from '../../core/services/vault/vaultStore'
import { FakeChain, FakeVaultWallet, fakeChainLookup } from './testSupport/fakeVaultChain'
import { ADMIN, CHAIN, VAULT_ID, newMember, publishVaultTx } from './testSupport/publishVault'
import { armSigner, buildKeyring, seedOwnMeta } from './testSupport/vaultHarness'
import type { MockYubiKey } from '../../core/services/vault/mockYubiKey'

jest.setTimeout(300_000)

const SCOPE_IDENTITY = `02${'55'.repeat(32)}`
const OTHER_VAULT_ID = 'cd'.repeat(32)

describe('hardening: scans add outputs only, set conflicting records apart, keep full withdrawal open', () => {
  const primaryKey = new PrivateKey(8642).toArray()
  let chain: FakeChain
  let wallet: FakeVaultWallet
  let mock: MockYubiKey
  let A: VaultInstructionKey
  let B: VaultInstructionKey
  let C: VaultInstructionKey
  const X = newMember('X', 11)
  const Y = newMember('Y', 12)

  beforeAll(async () => {
    const keyring = await buildKeyring(3)
    mock = keyring.mock
    ;[A, B, C] = keyring.keys
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

  const proveWith = (key: VaultInstructionKey) => async () => key
  const lookup = () => fakeChainLookup(chain)
  const pubkeys = (keys: readonly { pubkey: string }[]): string[] => keys.map(k => k.pubkey)

  /** A transaction that spends vault output `txid:0`, so the scan sees it as spent. */
  function spend(txid: string): void {
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: chain.tx(txid)!,
      sourceOutputIndex: 0,
      sequence: 0xffffffff,
      unlockingScript: new UnlockingScript([])
    })
    tx.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(Utils.toArray('f1'.repeat(20), 'hex')) })
    tx.addOutput({ satoshis: 7, lockingScript: LockingScript.fromHex('51') }) // makes each spend unique per source
    chain.publish(tx)
  }

  /** Put a published record in the local basket directly, as a wallet that
   * already holds it would (the scan's own admission is bypassed). */
  async function internalizeDirect(published: { txid: string; customInstructions: string }): Promise<void> {
    await wallet.internalizeAction(
      {
        tx: chain.tx(published.txid)!.toAtomicBEEF(),
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: 'admin vault',
              customInstructions: published.customInstructions,
              tags: ['vault']
            }
          }
        ],
        description: 'test',
        seekPermission: false
      },
      ADMIN
    )
  }

  async function seedMeta(meta: Partial<VaultMeta> = {}): Promise<void> {
    await seedOwnMeta(wallet, { v: 6, vaultId: VAULT_ID, revision: 1, createdAt: 1, keys: [A, B], ...meta })
  }

  async function withdrawAllWithA(): Promise<void> {
    armSigner(mock, A.serial)
    const result = await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw', A.serial)
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/)
    expect(wallet.localVaultOutpoints()).toEqual([])
  }

  it('decoy-wedge PoC: a 1-sat copy of an old spent pre-removal deposit does not create a pendingRemoval or block withdraw/deposit/re-lock', async () => {
    const old = await publishVaultTx(wallet, chain, 1, [A, B, C], 300_000, { revision: 1 })
    spend(old.txid)
    await publishVaultTx(wallet, chain, 2, [A, B], 300_000, { revision: 2 })
    const copy = await publishVaultTx(wallet, chain, 1, [A, B, C], 1, { revision: 1 })
    expect(copy.txid).not.toBe(old.txid)

    const result = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A))
    expect(result.found).toBe(1)
    expect(result.ignoredBelowMinimum).toBe(1)
    const meta = (await vaultStore.getMeta())!
    expect(meta.revision).toBe(2)
    expect(pubkeys(meta.keys)).toEqual(pubkeys([A, B]))
    expect(meta.pendingRemoval).toBeUndefined()
    await withdrawAllWithA()
  })

  it('decoy-wedge: a 100,000-sat copy of the spent revision-1 record is a lower revision of the same lineage and infers no removal', async () => {
    const old = await publishVaultTx(wallet, chain, 1, [A, B, C], 300_000, { revision: 1 })
    spend(old.txid)
    await publishVaultTx(wallet, chain, 2, [A, B], 300_000, { revision: 2 })
    await publishVaultTx(wallet, chain, 1, [A, B, C], 100_000, { revision: 1 })

    const result = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A))
    expect(result.found).toBe(2)
    const meta = (await vaultStore.getMeta())!
    expect(meta.pendingRemoval).toBeUndefined()
    expect(meta.revision).toBe(2)
    await withdrawAllWithA()
  })

  it('metaFromVerifiedOutputs never synthesizes a pendingRemoval', () => {
    const instructions = (revision: number, keys: VaultInstructionKey[]) => ({
      v: 6 as const,
      type: 'R1C' as const,
      salt: 'ab'.repeat(32),
      saltKeyId: '1',
      chain: 'main' as const,
      vaultId: VAULT_ID,
      revision,
      createdAt: 1,
      keys
    })
    const recovered = metaFromVerifiedOutputs([
      { instructions: instructions(1, [A, B, C]), txid: 'aa'.repeat(32) },
      { instructions: instructions(2, [A, B]), txid: 'bb'.repeat(32) }
    ])
    expect(recovered.revision).toBe(2)
    expect(pubkeys(recovered.keys)).toEqual(pubkeys([A, B]))
    expect(recovered.pendingRemoval).toBeUndefined()
    // Still a validator: disagreement throws.
    expect(() =>
      metaFromVerifiedOutputs([
        { instructions: instructions(2, [A, B]), txid: 'aa'.repeat(32) },
        { instructions: instructions(2, [A, C]), txid: 'bb'.repeat(32) }
      ])
    ).toThrow('Conflicting vault key sets')
  })

  it('planted-lockout form 1: a newer-dated record with a different vaultId makes a no-tap restore report conflict and internalize nothing; the real deposits are not hidden', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    await publishVaultTx(wallet, chain, 2, [A, B], 300_000)
    await publishVaultTx(wallet, chain, 3, [X, Y], 100_000, { vaultId: OTHER_VAULT_ID, createdAt: 99 })

    const result = await recoverVaultFromChain(wallet, ADMIN, lookup(), CHAIN)
    expect(result.conflict).toBe(true)
    expect(result.found).toBe(0)
    expect(result.setApart).toHaveLength(2)
    expect(result.groups).toHaveLength(2)
    expect(new Set(result.groups!.map(g => g.id)).size).toBe(2)
    expect(result.groups!.find(g => g.vaultId === VAULT_ID)).toMatchObject({ outputs: 2, satoshis: 600_000 })
    expect(wallet.hasLocalVaultOutputs()).toBe(false)
    expect(await vaultStore.getMeta()).toBeNull()
    expect(result.status).toBe('complete')
  })

  it("planted-lockout form 2: a record with another vaultId naming the real key makes recoverVaultWithKey report conflict; with options.groupId set to the real group's id it restores that group and withdraws", async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    await publishVaultTx(wallet, chain, 2, [A, X], 100_000, { vaultId: OTHER_VAULT_ID, createdAt: 99 })

    const conflict = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A))
    expect(conflict).toMatchObject({ conflict: true, found: 0, key: { pubkey: A.pubkey } })
    expect(conflict.setApart).toHaveLength(2)
    expect(wallet.hasLocalVaultOutputs()).toBe(false)

    await expect(
      recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A), undefined, { groupId: 'nope' })
    ).rejects.toMatchObject({ code: 'key-opens-nothing' })

    const restored = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A), undefined, {
      groupId: `${VAULT_ID}:1`
    })
    expect(restored.conflict).toBe(false)
    expect(restored.found).toBe(1)
    expect(restored.setApart).toHaveLength(1)
    expect(pubkeys((await vaultStore.getMeta())!.keys)).toEqual(pubkeys([A, B]))
    await withdrawAllWithA()
  })

  it('restore with one tapped key restores only a group that contains that key', async () => {
    const mine = await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    await publishVaultTx(wallet, chain, 2, [X, Y], 400_000, { vaultId: OTHER_VAULT_ID, createdAt: 5 })

    const result = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A))
    expect(result).toMatchObject({ found: 1, unreachable: 1, conflict: false })
    expect(result.groups).toHaveLength(1)
    expect(result.setApart).toEqual([])
    expect(wallet.localVaultOutpoints()).toEqual([`${mine.txid}.0`])
    expect((await vaultStore.getMeta())!.vaultId).toBe(VAULT_ID)
  })

  it('planted-key PoC (a): a planted revision-2 record adding key X restores without throwing, with A the only proven key, and a full withdrawal with A selects both outputs', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000, { revision: 1 })
    await publishVaultTx(wallet, chain, 2, [A, B, X], 100_000, { revision: 2 })

    const result = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A))
    expect(result.found).toBe(2)
    const meta = (await vaultStore.getMeta())!
    expect(meta.revision).toBe(2)
    expect(pubkeys(meta.keys)).toEqual(pubkeys([A, B, X]))
    expect(vaultStore.provenKeyRecords(meta).map(k => k.pubkey)).toEqual([A.pubkey])
    await withdrawAllWithA() // both outputs: the basket is empty afterwards
  })

  it('with local meta present, a planted higher-revision record that adds an unknown key is not internalized and does not supersede meta', async () => {
    await seedMeta()
    const real = await publishVaultTx(wallet, chain, 2, [A, B], 300_000, { revision: 1 })
    const planted = await publishVaultTx(wallet, chain, 1, [A, B, X], 100_000, { revision: 2 })

    const result = await scanVaultDeposits(wallet, ADMIN, lookup(), CHAIN)
    expect(result.found).toBe(1)
    expect(result.conflict).toBe(false)
    expect(result.setApart).toHaveLength(1)
    expect(result.setApart![0]).toMatchObject({ revision: 2, outputs: 1 })
    expect(wallet.localVaultOutpoints()).toEqual([`${real.txid}.0`])
    expect(pubkeys((await vaultStore.getMeta())!.keys)).toEqual(pubkeys([A, B]))

    // Even once P sits in the basket, the recovered record names an unknown key.
    await internalizeDirect(planted)
    const before = (await vaultStore.getMeta())!
    expect(await recoverVaultMetaFromOutputs(wallet, ADMIN)).toEqual(before)
    const after = (await vaultStore.getMeta())!
    expect(after.revision).toBe(1)
    expect(pubkeys(after.keys)).toEqual(pubkeys([A, B]))
  })

  it('a higher revision whose keys are all known (the crash-recovery case) still supersedes', async () => {
    await seedMeta()
    const next = await publishVaultTx(wallet, chain, 1, [A, B], 300_000, { revision: 2 })
    await internalizeDirect(next)

    const recovered = await recoverVaultMetaFromOutputs(wallet, ADMIN)
    expect(recovered?.revision).toBe(2)
    expect(pubkeys(recovered!.keys)).toEqual(pubkeys([A, B]))
    expect((await vaultStore.getMeta())!.revision).toBe(2)
  })

  it('a scan also admits a higher revision whose keys are all known', async () => {
    await seedMeta()
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000, { revision: 2 })
    const result = await scanVaultDeposits(wallet, ADMIN, lookup(), CHAIN)
    expect(result.found).toBe(1)
    expect((await vaultStore.getMeta())!.revision).toBe(2)
  })

  it('selectVaultInputs: a full withdrawal succeeds while the basket holds an output of a newer revision with an unknown key; a re-lock (and a partial withdrawal with a remainder) refuses with template-invalid', async () => {
    await seedMeta()
    const real = await publishVaultTx(wallet, chain, 1, [A, B], 400_000, { revision: 1 })
    const planted = await publishVaultTx(wallet, chain, 2, [A, B, X], 300_000, { revision: 2 })
    await internalizeDirect(real)
    await internalizeDirect(planted)
    armSigner(mock, A.serial)

    await expect(relockVault(wallet, ADMIN, 'Re-lock', A.serial)).rejects.toMatchObject({ code: 'template-invalid' })
    await expect(withdrawFromVault(wallet, ADMIN, 200_000, 'Partial', A.serial)).rejects.toMatchObject({
      code: 'template-invalid'
    })
    expect(wallet.localVaultOutpoints()).toHaveLength(2)

    const result = await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw', A.serial)
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/)
    expect(wallet.localVaultOutpoints()).toEqual([])
  })

  it('forgetVaultSetup relinquishes every local vault output, clears meta even with a pendingRemoval, refuses while an action is pending, and a following scan restores the funds', async () => {
    await seedMeta({
      keys: [A, B],
      pendingRemoval: { key: { ...C }, keyIndex: 2, startedAt: 1, revision: 1, state: 'broadcast' }
    })
    const one = await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    const two = await publishVaultTx(wallet, chain, 2, [A, B], 200_000)
    await internalizeDirect(one)
    await internalizeDirect(two)
    expect((await vaultStore.getMeta())!.pendingRemoval).toBeDefined()

    const realList = wallet.listActions.bind(wallet)
    wallet.listActions = async () => ({
      actions: [{ reference: 'held-1', status: 'unsigned', labels: ['vault'] } as never],
      totalActions: 1
    })
    await expect(forgetVaultSetup(wallet, ADMIN)).rejects.toMatchObject({ code: 'action-pending' })
    expect(wallet.localVaultOutpoints()).toHaveLength(2)
    expect(await vaultStore.getMeta()).not.toBeNull()
    wallet.listActions = realList

    expect(await forgetVaultSetup(wallet, ADMIN)).toEqual({ forgottenOutputs: 2 })
    expect(wallet.hasLocalVaultOutputs()).toBe(false)
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await vaultStore.getMetaTag()).toBeNull()

    const scan = await recoverVaultFromChain(wallet, ADMIN, lookup(), CHAIN)
    expect(scan.found).toBe(2)
    const restored = (await vaultStore.getMeta())!
    expect(pubkeys(restored.keys)).toEqual(pubkeys([A, B]))
    expect(restored.pendingRemoval).toBeUndefined()
  })

  it('forgetVaultSetup works with no meta', async () => {
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await forgetVaultSetup(wallet, ADMIN)).toEqual({ forgottenOutputs: 0 })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  it('planted-lockout form 3 (same revision): a record with the real vaultId, createdAt and latest revision but another key list does not make restore throw', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000, { revision: 1 })
    await publishVaultTx(wallet, chain, 2, [A, B, X], 100_000, { revision: 1 })

    const noTap = await recoverVaultFromChain(wallet, ADMIN, lookup(), CHAIN)
    expect(noTap.conflict).toBe(true)
    expect(noTap.found).toBe(0)
    expect(noTap.groups).toHaveLength(2)
    const ids = noTap.groups!.map(g => g.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every(id => id.startsWith(`${VAULT_ID}:1:`) && /:[0-9a-f]{16}$/.test(id))).toBe(true)

    const tapped = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A))
    expect(tapped).toMatchObject({ conflict: true, found: 0 })

    const pick = noTap.groups!.find(g => g.keys.length === 2)!.id
    const restored = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A), undefined, {
      groupId: pick
    })
    expect(restored.found).toBe(1)
    expect(restored.setApart).toHaveLength(1)
    expect(pubkeys((await vaultStore.getMeta())!.keys)).toEqual(pubkeys([A, B]))
    await withdrawAllWithA()
  })

  it('planted-lockout form 4 (high revision, other keys): a record with the real vaultId and createdAt, revision 99 and keys {X,Y} does not hide the real deposit from a tapped restore', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000, { revision: 1 })
    await publishVaultTx(wallet, chain, 2, [X, Y], 100_000, { revision: 99 })

    // No tap: one lineage, both outputs, the planted revision wins; nothing throws.
    const noTap = await recoverVaultFromChain(wallet, ADMIN, lookup(), CHAIN)
    expect(noTap).toMatchObject({ found: 2, conflict: false, problems: [], status: 'complete' })
    const planted = (await vaultStore.getMeta())!
    expect(planted.revision).toBe(99)
    expect(pubkeys(planted.keys)).toEqual(pubkeys([X, Y]))

    // The exit: forget the setup, then restore with the tap.
    expect(await forgetVaultSetup(wallet, ADMIN)).toEqual({ forgottenOutputs: 2 })
    const tapped = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A))
    expect(tapped).toMatchObject({ found: 1, conflict: false, unreachable: 1 })
    expect(tapped.groups).toHaveLength(1)
    expect(tapped.setApart).toEqual([])
    const meta = (await vaultStore.getMeta())!
    expect(meta.revision).toBe(1)
    expect(pubkeys(meta.keys)).toEqual(pubkeys([A, B]))
    await withdrawAllWithA()
  })

  it('review fix 1: meta at revision 2, real output at revision 1, a planted revision-1 variant with other keys does not wedge scan or rebuild', async () => {
    await seedMeta({ revision: 2 })
    const real = await publishVaultTx(wallet, chain, 1, [A, B], 300_000, { revision: 1 })
    const planted = await publishVaultTx(wallet, chain, 2, [A, B, X], 100_000, { revision: 1 })

    const first = await scanVaultDeposits(wallet, ADMIN, lookup(), CHAIN)
    expect(first.problems).toEqual([])
    expect(first.found).toBeGreaterThanOrEqual(1)
    const meta = (await vaultStore.getMeta())!
    expect(meta.revision).toBe(2)
    expect(pubkeys(meta.keys)).toEqual(pubkeys([A, B]))

    // Rescan and a rebuild with the planted record already in the basket: no throw.
    await internalizeDirect(real)
    await internalizeDirect(planted)
    await expect(scanVaultDeposits(wallet, ADMIN, lookup(), CHAIN)).resolves.toBeDefined()
    const rebuilt = await recoverVaultMetaFromOutputs(wallet, ADMIN)
    expect(rebuilt?.revision).toBe(2)
    expect(pubkeys(rebuilt!.keys)).toEqual(pubkeys([A, B]))
    await withdrawAllWithA()
  })

  it('review fix 2: a basket holding another group does not make a later restore of a different group throw; meta is built from the chosen group only', async () => {
    const mine = await publishVaultTx(wallet, chain, 1, [A, B], 300_000)
    const other = await publishVaultTx(wallet, chain, 2, [A, X], 200_000, { vaultId: OTHER_VAULT_ID, createdAt: 5 })

    const first = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A), undefined, {
      groupId: `${VAULT_ID}:1`
    })
    expect(first.found).toBe(1)
    // The device lost its meta (or it is untagged) but the basket keeps the output.
    await vaultStore.forgetSetup()
    expect(await vaultStore.getMeta()).toBeNull()

    // An unfiltered rebuild with two lineages in the basket picks nothing and does not throw.
    await internalizeDirect(other)
    await expect(recoverVaultMetaFromOutputs(wallet, ADMIN)).resolves.toBeNull()

    const second = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A), undefined, {
      groupId: `${OTHER_VAULT_ID}:5`
    })
    expect(second.problems).toEqual([])
    const meta = (await vaultStore.getMeta())!
    expect(meta.vaultId).toBe(OTHER_VAULT_ID)
    expect(pubkeys(meta.keys)).toEqual(pubkeys([A, X]))
    expect(wallet.localVaultOutpoints()).toContain(`${mine.txid}.0`)
  })

  it('review fix 2b: a basket holding two key-list variants of one lineage restores the chosen variant without throwing', async () => {
    await publishVaultTx(wallet, chain, 1, [A, B], 300_000, { revision: 1 })
    await publishVaultTx(wallet, chain, 2, [A, B, X], 100_000, { revision: 1 })
    const noTap = await recoverVaultFromChain(wallet, ADMIN, lookup(), CHAIN)
    const planted = noTap.groups!.find(g => g.keys.length === 3)!.id
    const real = noTap.groups!.find(g => g.keys.length === 2)!.id

    await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A), undefined, { groupId: planted })
    await vaultStore.forgetSetup()
    const restored = await recoverVaultWithKey(wallet, ADMIN, lookup(), CHAIN, proveWith(A), undefined, {
      groupId: real
    })
    expect(restored.problems).toEqual([])
    expect(pubkeys((await vaultStore.getMeta())!.keys)).toEqual(pubkeys([A, B]))
  })
})
