/**
 * Hardening: a new Vault lock commits only keys proven by a tap (planted-key).
 *
 * A mnemonic-only attacker plants a record that lists the victim's keys plus
 * his own (verify-authority/planted_key_poc.cjs). After a restore the list
 * holds that key. Deposits, partial-withdrawal remainders and re-locks must
 * never commit a key no tap has proven, and the exit (full withdrawal) must
 * stay open (R1).
 */
import { Utils } from '@bsv/sdk'
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
import { adoptVaultKey } from '../../core/services/vault/VaultKeyService'
import { bakedCommitments, commitment, decodeVaultInstructionsV7 } from '../../core/services/vault/r1comb'
import { planLockKeys } from '../../core/services/vault/lockKeys'
import { vaultStore, type VaultKeyRecord, type VaultMeta } from '../../core/services/vault/vaultStore'
import { computeVaultMetaAuthorityTag } from '../../core/services/vault/metaAuthority'
import { recoverVaultFromChain } from '../../core/services/vault/chainRecovery'
import {
  deriveVaultSalt,
  depositToVault,
  previewVaultWithdrawal,
  recoverVaultMetaFromOutputs,
  relockVault,
  withdrawFromVault
} from '../../core/services/vault/transfers'
import { generateMnemonicWallet } from '../../core/mnemonicWallet'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { FakeChain, FakeVaultWallet, fakeChainLookup } from './testSupport/fakeVaultChain'
import { resetSaltFloors, setVaultChainLookup } from '../../core/services/vault/markerLookup'
import { ADMIN, armSigner, buildKeyring, seedOwnMeta } from './testSupport/vaultHarness'

jest.setTimeout(300_000)

const hex = (a: ArrayLike<number>): string => Utils.toHex(Array.from(a))
const identityKey = `02${'d4'.repeat(32)}`

afterEach(() => {
  setVaultChainLookup(null)
  jest.restoreAllMocks()
})

beforeEach(async () => {
  await AsyncStorage.clear()
  ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
  vaultStore.clearScope()
  resetSaltFloors()
  ;(requestVaultSigner as jest.Mock).mockReset()
})

async function wipeDevice(): Promise<void> {
  await AsyncStorage.clear()
  ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
  vaultStore.clearScope()
  vaultStore.configureScope({ identityKey, chain: 'test' })
}

interface World {
  chain: FakeChain
  mock: MockYubiKey
  keys: VaultKeyRecord[]
  primaryKey: number[]
  vaultId: string
  createdAt: number
}

async function newWorld(keyCount: number): Promise<World> {
  const chain = new FakeChain()
  setVaultChainLookup(fakeChainLookup(chain))
  const { mock, keys } = await buildKeyring(keyCount)
  vaultStore.configureScope({ identityKey, chain: 'test' })
  return {
    chain,
    mock,
    keys,
    primaryKey: generateMnemonicWallet().primaryKey,
    vaultId: hex(p256.utils.randomSecretKey()),
    createdAt: Date.now()
  }
}

/** The phone that enrolled the Vault: no recovery state, every key proven. */
async function enrolledPhone(world: World, keys: VaultKeyRecord[], deposits: number[]): Promise<FakeVaultWallet> {
  const phone = new FakeVaultWallet(world.primaryKey, world.chain)
  await seedOwnMeta(phone, { v: 6, vaultId: world.vaultId, revision: 1, createdAt: world.createdAt, keys })
  armSigner(world.mock, keys[0].serial)
  for (const sats of deposits) await depositToVault(phone, ADMIN, sats)
  return phone
}

/** Real deposits R at revision 1 under {A,B}, then the attacker's planted
 * output P at revision 2 under {A,B,X} (the same vaultId and createdAt, as
 * read from any real descriptor). Then a wiped phone restores from the chain. */
async function restoredWithPlantedKey(
  adopt: number[],
  opts: { pendingPlant?: boolean } = {}
): Promise<{ world: World; phone: FakeVaultWallet; pendingTxid?: string }> {
  const world = await newWorld(3)
  const [A, B, X] = world.keys
  const original = await enrolledPhone(world, [A, B], [500_000, 500_000])
  await seedOwnMeta(original, {
    v: 6,
    vaultId: world.vaultId,
    revision: 2,
    createdAt: world.createdAt,
    keys: [A, B, X]
  })
  await depositToVault(original, ADMIN, 500_000)
  // A second planted output (same planted key set) that is not confirmed yet:
  // the restore does not see it, a later rescan does.
  let pendingTxid: string | undefined
  if (opts.pendingPlant) {
    pendingTxid = (await depositToVault(original, ADMIN, 500_000)).txid
    world.chain.setConfirmed(pendingTxid, false)
  }

  await wipeDevice()
  const phone = new FakeVaultWallet(world.primaryKey, world.chain)
  const recovery = await recoverVaultFromChain(phone, ADMIN, fakeChainLookup(world.chain), 'test')
  expect(recovery.found).toBe(3)
  expect(recovery.pendingConfirmation).toBe(opts.pendingPlant ? 1 : 0)
  const meta = await vaultStore.getMeta()
  expect(meta?.keys.map(k => k.serial)).toEqual([A, B, X].map(k => k.serial))
  expect(meta?.recovery?.required).toBe(true)
  for (const i of adopt) {
    armSigner(world.mock, world.keys[i].serial)
    await adoptVaultKey({ record: world.keys[i], onPhase: () => {}, getPin: async () => '123456' })
  }
  ;(requestVaultSigner as jest.Mock).mockClear()
  return { world, phone, pendingTxid }
}

/** Commitments baked into output 0 of `txid`, and the salt-key index and key
 * serials its descriptor records. */
async function newLock(
  phone: FakeVaultWallet,
  world: World,
  txid: string
): Promise<{ commitments: string[]; saltKeyId: string; instructionSerials: string[]; revision: number }> {
  const lock = world.chain.tx(txid)!.outputs[0].lockingScript
  const listed = await phone.listOutputs({ basket: 'admin vault', includeCustomInstructions: true })
  const row = listed.outputs.find(o => o.outpoint === `${txid}.0`)!
  const v7 = decodeVaultInstructionsV7(row.customInstructions)!
  return {
    commitments: bakedCommitments(lock),
    saltKeyId: v7.saltKeyId,
    instructionSerials: v7.keys.map(k => k.serial),
    revision: v7.revision
  }
}

const expectedCommitments = async (
  phone: FakeVaultWallet,
  saltKeyId: string,
  locked: VaultKeyRecord[]
): Promise<string[]> => {
  const salt = await deriveVaultSalt(
    phone,
    ADMIN,
    saltKeyId,
    locked.map(k => k.serial)
  )
  return locked.map(k => commitment(k.pubkey, salt))
}

describe('hardening: a new lock commits only proven keys (planted-key)', () => {
  it('planted-key PoC: after restore with taps of A and B and a planted key X, a deposit refuses with keys-unproven and creates no action', async () => {
    const { world, phone } = await restoredWithPlantedKey([0, 1])
    const [A, , X] = world.keys
    const createAction = jest.spyOn(phone, 'createAction')
    armSigner(world.mock, A.serial)
    ;(requestVaultSigner as jest.Mock).mockClear()

    await expect(depositToVault(phone, ADMIN, 250_000, { outputKeySerial: A.serial })).rejects.toMatchObject({
      code: 'keys-unproven',
      details: { serials: X.serial }
    })
    expect(createAction).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('partial withdrawal remainder refuses with keys-unproven before any tap when X is unproven, and succeeds with acceptDroppingUnproven: the new lock commits exactly {A,B}', async () => {
    const { world, phone } = await restoredWithPlantedKey([0, 1])
    const [A, B, X] = world.keys
    armSigner(world.mock, A.serial)
    ;(requestVaultSigner as jest.Mock).mockClear()
    const createAction = jest.spyOn(phone, 'createAction')

    await expect(withdrawFromVault(phone, ADMIN, 300_000, 'Withdraw', A.serial)).rejects.toMatchObject({
      code: 'keys-unproven',
      details: { serials: X.serial }
    })
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(createAction).not.toHaveBeenCalled()

    const spend = await withdrawFromVault(phone, ADMIN, 300_000, 'Withdraw', A.serial, {
      acceptDroppingUnproven: true
    })
    // The planted output P was spent with A together with the two real ones.
    expect(world.chain.tx(spend.txid)!.inputs).toHaveLength(3)
    const lock = await newLock(phone, world, spend.txid)
    expect(lock.commitments).toEqual(await expectedCommitments(phone, lock.saltKeyId, [A, B]))
    expect(lock.commitments).toHaveLength(2)
    expect(lock.instructionSerials).toEqual([A.serial, B.serial])
  })

  it('after that remainder, local meta has keys [A,B] at revision+1, no X, and a planted output seen later still withdraws with A', async () => {
    const { world, phone, pendingTxid } = await restoredWithPlantedKey([0, 1], { pendingPlant: true })
    const [A, B, X] = world.keys
    armSigner(world.mock, A.serial)
    const before = (await vaultStore.getMeta())!
    expect(before.revision).toBe(2)

    await withdrawFromVault(phone, ADMIN, 300_000, 'Withdraw', A.serial, { acceptDroppingUnproven: true })

    const meta = (await vaultStore.getMeta())!
    expect(meta.keys.map(k => k.serial)).toEqual([A.serial, B.serial])
    expect(meta.keys.some(k => k.serial === X.serial)).toBe(false)
    expect(meta.revision).toBe(3)

    // The second planted output (committed to {A,B,X}, revision 2) confirms and
    // a rescan finds it: it is older than meta, so it is admitted, and A opens it.
    world.chain.setConfirmed(pendingTxid!, true)
    const rescan = await recoverVaultFromChain(phone, ADMIN, fakeChainLookup(world.chain), 'test')
    expect(rescan.problems).toEqual([])
    const rest = await withdrawFromVault(phone, ADMIN, 'all', 'Withdraw rest', A.serial)
    const spentSources = world.chain.tx(rest.txid)!.inputs.map(i => i.sourceTransaction!.id('hex'))
    expect(spentSources).toContain(pendingTxid)
    expect((await vaultStore.getMeta())!.keys.map(k => k.serial)).toEqual([A.serial, B.serial])
  })

  it("one proven key: remainder refuses with not-enough-proven-keys; withdraw 'all' succeeds (R1)", async () => {
    const { world, phone } = await restoredWithPlantedKey([0])
    const [A] = world.keys
    armSigner(world.mock, A.serial)
    ;(requestVaultSigner as jest.Mock).mockClear()

    await expect(
      withdrawFromVault(phone, ADMIN, 300_000, 'Withdraw', A.serial, { acceptDroppingUnproven: true })
    ).rejects.toMatchObject({ code: 'not-enough-proven-keys', details: { proven: 1 } })
    expect(requestVaultSigner).not.toHaveBeenCalled()

    const all = await withdrawFromVault(phone, ADMIN, 'all', 'Withdraw all', A.serial)
    expect(all.txid).toBeTruthy()
  })

  it('re-lock with one proven key and no staged key refuses with not-enough-proven-keys', async () => {
    const { world, phone } = await restoredWithPlantedKey([0])
    const [A] = world.keys
    armSigner(world.mock, A.serial)
    ;(requestVaultSigner as jest.Mock).mockClear()

    await expect(relockVault(phone, ADMIN, 'Re-lock', A.serial)).rejects.toMatchObject({ code: 'keys-unproven' })
    await expect(
      relockVault(phone, ADMIN, 'Re-lock', A.serial, { acceptDroppingUnproven: true })
    ).rejects.toMatchObject({ code: 'not-enough-proven-keys', details: { proven: 1 } })
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('a legacy-adopted (serial-only) meta is treated as unproven and refuses a deposit', async () => {
    const world = await newWorld(2)
    const [A, B] = world.keys
    const phone = new FakeVaultWallet(world.primaryKey, world.chain)
    await seedOwnMeta(phone, {
      v: 6,
      vaultId: world.vaultId,
      revision: 2,
      createdAt: world.createdAt,
      keys: [A, B],
      recovery: { required: true, adoptedSerials: [A.serial, B.serial] }
    })
    armSigner(world.mock, A.serial)
    const createAction = jest.spyOn(phone, 'createAction')

    await expect(depositToVault(phone, ADMIN, 250_000, { outputKeySerial: A.serial })).rejects.toMatchObject({
      code: 'keys-unproven',
      details: { serials: B.serial }
    })
    expect(createAction).not.toHaveBeenCalled()
  })

  it('a locally enrolled vault deposits as before and its remainder and re-lock use all keys at the same revision', async () => {
    const world = await newWorld(2)
    const [A, B] = world.keys
    const phone = await enrolledPhone(world, [A, B], [500_000, 500_000])
    armSigner(world.mock, A.serial)

    const partial = await withdrawFromVault(phone, ADMIN, 300_000, 'Withdraw', A.serial)
    const lock = await newLock(phone, world, partial.txid)
    expect(lock.commitments).toEqual(await expectedCommitments(phone, lock.saltKeyId, [A, B]))
    expect(lock.revision).toBe(1)

    const relock = await relockVault(phone, ADMIN, 'Re-lock', A.serial)
    const relocked = await newLock(phone, world, relock.txid)
    expect(relocked.commitments).toEqual(await expectedCommitments(phone, relocked.saltKeyId, [A, B]))
    expect(relocked.revision).toBe(1)
    const meta = (await vaultStore.getMeta())!
    expect(meta.revision).toBe(1)
    expect(meta.keys).toEqual([A, B])
  })

  it('a lost key that was proven at enrollment stays in the lock: partial withdrawal on the enrolling phone commits {A,B,C}', async () => {
    const world = await newWorld(3)
    const [A, B, C] = world.keys
    const phone = await enrolledPhone(world, [A, B, C], [600_000])
    armSigner(world.mock, A.serial) // only A is present; B and C are "lost"

    const spend = await withdrawFromVault(phone, ADMIN, 200_000, 'Withdraw', A.serial)
    const lock = await newLock(phone, world, spend.txid)
    expect(lock.commitments).toEqual(await expectedCommitments(phone, lock.saltKeyId, [A, B, C]))
    expect(lock.commitments).toHaveLength(3)
    expect((await vaultStore.getMeta())!.revision).toBe(1)
  })

  it('previewVaultWithdrawal reports lockPlan: unproven X, proven A and B, needsRelock true or false', async () => {
    const { world, phone } = await restoredWithPlantedKey([0, 1])
    const [A, B, X] = world.keys

    const partial = await previewVaultWithdrawal(phone, ADMIN, A.serial, 300_000)
    expect(partial.lockPlan).toEqual({
      needsRelock: true,
      provenSerials: [A.serial, B.serial],
      unprovenSerials: [X.serial]
    })
    const small = await previewVaultWithdrawal(phone, ADMIN, A.serial, 1_450_000)
    expect(small.lockPlan?.needsRelock).toBe(false)
    const all = await previewVaultWithdrawal(phone, ADMIN, A.serial, 'all')
    expect(all.lockPlan?.needsRelock).toBe(false)
  })

  it('previewVaultWithdrawal flags blocked when fewer than two keys could be locked', async () => {
    const { world, phone } = await restoredWithPlantedKey([0])
    const [A, B, X] = world.keys
    const preview = await previewVaultWithdrawal(phone, ADMIN, A.serial, 300_000)
    expect(preview.lockPlan).toEqual({
      needsRelock: true,
      provenSerials: [A.serial],
      unprovenSerials: [B.serial, X.serial],
      blocked: 'not-enough-proven-keys'
    })
  })

  it('a failing local commit after a broadcast leaves the chain output; recoverVaultMetaFromOutputs then reaches the same key set', async () => {
    const { world, phone } = await restoredWithPlantedKey([0, 1])
    const [A, B] = world.keys
    armSigner(world.mock, A.serial)
    jest.spyOn(vaultStore, 'commitLockKeySet').mockRejectedValueOnce(new Error('disk full'))

    await expect(
      withdrawFromVault(phone, ADMIN, 300_000, 'Withdraw', A.serial, { acceptDroppingUnproven: true })
    ).rejects.toThrow('disk full')
    // The spend went out; local meta never learned about the new key set.
    expect((await vaultStore.getMeta())!.revision).toBe(2)

    await recoverVaultMetaFromOutputs(phone, ADMIN)
    const meta = (await vaultStore.getMeta())!
    expect(meta.keys.map(k => k.serial)).toEqual([A.serial, B.serial])
    expect(meta.revision).toBe(3)
  })

  it('salt for the new output derives from the lock key serials', async () => {
    const { world, phone } = await restoredWithPlantedKey([0, 1])
    const [A, B, X] = world.keys
    armSigner(world.mock, A.serial)
    const spend = await withdrawFromVault(phone, ADMIN, 300_000, 'Withdraw', A.serial, {
      acceptDroppingUnproven: true
    })
    const lock = await newLock(phone, world, spend.txid)
    // Derived over [A,B] it matches; derived over the list that still had X it does not.
    expect(lock.commitments).toEqual(await expectedCommitments(phone, lock.saltKeyId, [A, B]))
    const withX = await deriveVaultSalt(phone, ADMIN, lock.saltKeyId, [A.serial, B.serial, X.serial])
    const salt = await deriveVaultSalt(phone, ADMIN, lock.saltKeyId, [A.serial, B.serial])
    expect(withX).not.toEqual(salt)
    expect(lock.commitments[0]).toEqual(commitment(A.pubkey, salt))
  })

  it('re-lock with acceptDroppingUnproven commits the proven keys only, at revision+1, and writes the new key set', async () => {
    const { world, phone } = await restoredWithPlantedKey([0, 1])
    const [A, B] = world.keys
    armSigner(world.mock, A.serial)

    const relock = await relockVault(phone, ADMIN, 'Re-lock', A.serial, { acceptDroppingUnproven: true })
    const lock = await newLock(phone, world, relock.txid)
    expect(lock.commitments).toEqual(await expectedCommitments(phone, lock.saltKeyId, [A, B]))
    expect(lock.revision).toBe(3)
    const meta = (await vaultStore.getMeta())!
    expect(meta.keys.map(k => k.serial)).toEqual([A.serial, B.serial])
    expect(meta.revision).toBe(3)
    // Every proven key is now in the list and a plain re-lock needs no consent.
    const again = await relockVault(phone, ADMIN, 'Re-lock again', A.serial)
    expect((await newLock(phone, world, again.txid)).revision).toBe(3)
  })

  it('a restore without a planted key, with every key tapped, partial-withdraws and re-locks to all keys at the same revision', async () => {
    const world = await newWorld(3)
    const [A, B, C] = world.keys
    await enrolledPhone(world, [A, B, C], [500_000, 500_000])
    await wipeDevice()
    const phone = new FakeVaultWallet(world.primaryKey, world.chain)
    await recoverVaultFromChain(phone, ADMIN, fakeChainLookup(world.chain), 'test')
    for (const key of [B, C, A]) {
      armSigner(world.mock, key.serial)
      await adoptVaultKey({ record: key, onPhase: () => {}, getPin: async () => '123456' })
    }
    const partial = await withdrawFromVault(phone, ADMIN, 200_000, 'Withdraw', A.serial)
    const remainder = await newLock(phone, world, partial.txid)
    expect(remainder.commitments).toEqual(await expectedCommitments(phone, remainder.saltKeyId, [A, B, C]))
    const relock = await relockVault(phone, ADMIN, 'Re-lock', A.serial)
    const relocked = await newLock(phone, world, relock.txid)
    expect(relocked.commitments).toEqual(await expectedCommitments(phone, relocked.saltKeyId, [A, B, C]))
    expect((await vaultStore.getMeta())!.revision).toBe(1)
  })

  it('commitLockKeySet writes keys and revision in one tagged write, prunes adoption pairs of dropped keys and refuses a lower revision', async () => {
    const world = await newWorld(3)
    const [A, B, X] = world.keys
    const phone = new FakeVaultWallet(world.primaryKey, world.chain)
    const pair = (k: VaultKeyRecord): { serial: string; pubkey: string } => ({ serial: k.serial, pubkey: k.pubkey })
    await seedOwnMeta(phone, {
      v: 6,
      vaultId: world.vaultId,
      revision: 2,
      createdAt: world.createdAt,
      keys: [A, B, X],
      lastUsedSerial: X.serial,
      lastUsedAt: 5,
      recovery: {
        required: true,
        adoptedSerials: [A.serial, B.serial, X.serial],
        adopted: [pair(A), pair(B), pair(X)]
      }
    })
    const scope = vaultStore.getScope()!
    const tagger = (next: Parameters<typeof computeVaultMetaAuthorityTag>[2]): Promise<string> =>
      computeVaultMetaAuthorityTag(phone, ADMIN, next, scope)
    const current = (await vaultStore.getMeta())!

    await expect(
      vaultStore.commitLockKeySet({ keys: [A, B], revision: 2, clearStaged: false }, undefined, tagger, current)
    ).rejects.toMatchObject({ code: 'template-invalid' })

    await vaultStore.commitLockKeySet({ keys: [A, B], revision: 3, clearStaged: false }, undefined, tagger, current)
    const meta = (await vaultStore.getMeta())!
    expect(meta.revision).toBe(3)
    expect(meta.keys.map(k => k.serial)).toEqual([A.serial, B.serial])
    expect(meta.recovery).toEqual({
      required: true,
      adoptedSerials: [A.serial, B.serial],
      adopted: [pair(A), pair(B)]
    })
    expect(meta.lastUsedSerial).toBeUndefined()
    expect(meta.lastUsedAt).toBeUndefined()
  })

  it('commitLockKeySet keeps a pending removal valid: new revision and keyIndex within the shorter list', async () => {
    const world = await newWorld(5)
    const [A, B, C, D, E] = world.keys
    const phone = new FakeVaultWallet(world.primaryKey, world.chain)
    await seedOwnMeta(phone, {
      v: 6,
      vaultId: world.vaultId,
      revision: 2,
      createdAt: world.createdAt,
      keys: [A, B, C, D],
      pendingRemoval: { key: E, keyIndex: 4, startedAt: 5, revision: 2, state: 'prepared' }
    })
    const scope = vaultStore.getScope()!
    const current = (await vaultStore.getMeta())!
    await vaultStore.commitLockKeySet(
      { keys: [A, B], revision: 3, clearStaged: false },
      undefined,
      next => computeVaultMetaAuthorityTag(phone, ADMIN, next, scope),
      current
    )
    const meta = (await vaultStore.getMeta())!
    expect(meta.pendingRemoval).toMatchObject({ revision: 3, keyIndex: 2, state: 'prepared' })
  })

  describe('planLockKeys with a staged key', () => {
    const token = (): ReturnType<typeof vaultStore.captureScopeToken> => vaultStore.captureScopeToken()
    const baseMeta = (keys: VaultKeyRecord[], staged: VaultKeyRecord): VaultMeta => ({
      v: 6,
      vaultId: 'ab'.repeat(32),
      revision: 4,
      createdAt: 1,
      keys,
      staged
    })

    it('activation puts the staged key last, bumps the revision and flags a key-set change', async () => {
      const world = await newWorld(3)
      const [A, B, C] = world.keys
      const plan = planLockKeys({
        meta: baseMeta([A, B], C),
        scopeToken: token(),
        chosenSerial: A.serial,
        purpose: 'relock',
        activateStagedKey: C.serial
      })
      expect(plan.lockKeys.map(k => k.serial)).toEqual([A.serial, B.serial, C.serial])
      expect(plan.activated).toEqual(C)
      expect(plan.revision).toBe(5)
      expect(plan.changesKeySet).toBe(true)
      expect(plan.dropped).toEqual([])
    })

    it('without activation the staged key stays out of a re-lock and of a deposit', async () => {
      const world = await newWorld(3)
      const [A, B, C] = world.keys
      for (const purpose of ['relock', 'deposit'] as const) {
        const plan = planLockKeys({ meta: baseMeta([A, B], C), scopeToken: token(), chosenSerial: A.serial, purpose })
        expect(plan.lockKeys).toEqual([A, B])
        expect(plan.revision).toBe(4)
        expect(plan.changesKeySet).toBe(false)
      }
    })

    it('refuses a serial that is not the staged key, and a chosen key outside the list', async () => {
      const world = await newWorld(3)
      const [A, B, C] = world.keys
      expect(() =>
        planLockKeys({
          meta: baseMeta([A, B], C),
          scopeToken: token(),
          chosenSerial: A.serial,
          purpose: 'relock',
          activateStagedKey: B.serial
        })
      ).toThrow(expect.objectContaining({ code: 'not-enrolled' }))
      expect(() =>
        planLockKeys({ meta: baseMeta([A, B], C), scopeToken: token(), chosenSerial: C.serial, purpose: 'relock' })
      ).toThrow(expect.objectContaining({ code: 'not-enrolled' }))
    })
  })
})
