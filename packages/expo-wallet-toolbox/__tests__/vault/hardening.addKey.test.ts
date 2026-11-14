/**
 * Hardening: a new key is staged until a re-lock signed by an existing key
 * activates it (add-key, late-key).
 *
 * A phone-only attacker who runs the add-key wizard with his own key must not
 * get that key into any lock. addVaultKey only stages the key (`meta.staged`).
 * Only relockVault (or activateStagedKeyWithoutOutputs when nothing is funded),
 * both of which need a tap from an existing proven key, commit it.
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
import { addVaultKey, adoptVaultKey, discardStagedVaultKey } from '../../core/services/vault/VaultKeyService'
import { enrolledSerialRegistry } from '../../core/services/vault/enrolledSerialRegistry'
import { bakedCommitments, commitment, decodeVaultInstructionsV7 } from '../../core/services/vault/r1comb'
import { vaultStore, type VaultKeyRecord } from '../../core/services/vault/vaultStore'
import { computeVaultDraftAuthorityTag, verifyVaultMetaAuthorityTag } from '../../core/services/vault/metaAuthority'
import {
  activateStagedKeyWithoutOutputs,
  beginVaultKeyRemoval,
  deriveVaultSalt,
  depositToVault,
  recoverVaultMetaFromOutputs,
  relockVault,
  requireAuthenticatedMeta,
  withdrawFromVault
} from '../../core/services/vault/transfers'
import { generateMnemonicWallet } from '../../core/mnemonicWallet'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { FakeChain, FakeVaultWallet, fakeChainLookup } from './testSupport/fakeVaultChain'
import { resetSaltFloors, setVaultChainLookup } from '../../core/services/vault/markerLookup'
import { ADMIN, armSigner, buildKeyring, seedOwnMeta } from './testSupport/vaultHarness'

jest.setTimeout(300_000)

const hex = (a: ArrayLike<number>): string => Utils.toHex(Array.from(a))
const identityKey = `02${'e5'.repeat(32)}`

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

/** The wizard path: a tagged `ready` draft for the new key, written with the
 * same helper the wizard uses (preserveEnrollmentDraft + draft tag). */
async function stageReadyDraft(phone: FakeVaultWallet, record: VaultKeyRecord): Promise<void> {
  const scopeToken = vaultStore.captureScopeToken()
  const scope = vaultStore.getScope()!
  await vaultStore.preserveEnrollmentDraft({ record, assurance: 'ready' }, scopeToken, r =>
    computeVaultDraftAuthorityTag(phone, ADMIN, r, scope)
  )
}

const authority = (phone: FakeVaultWallet) => ({ wallet: phone, adminOriginator: ADMIN })

async function addKeyThroughWizard(phone: FakeVaultWallet, record: VaultKeyRecord) {
  await stageReadyDraft(phone, record)
  return await addVaultKey(record, undefined, authority(phone))
}

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

const serials = (keys: VaultKeyRecord[]): string[] => keys.map(k => k.serial)

describe('hardening: a new key is staged until an existing key re-locks (add-key, late-key)', () => {
  it('add-key PoC (phone only): addVaultKey with a ready draft of the attacker key stages it; meta.keys and revision are unchanged, and a following deposit commits only the original keys', async () => {
    const world = await newWorld(3)
    const [A, B, X] = world.keys
    const phone = await enrolledPhone(world, [A, B], [500_000])
    const before = (await vaultStore.getMeta())!

    const staged = await addKeyThroughWizard(phone, X)
    expect(staged.staged).toEqual(X)
    expect(serials(staged.keys)).toEqual(serials([A, B]))
    expect(staged.revision).toBe(before.revision)
    const stored = (await vaultStore.getMeta())!
    expect(stored.staged).toEqual(X)
    expect(serials(stored.keys)).toEqual(serials([A, B]))
    expect(stored.revision).toBe(before.revision)

    armSigner(world.mock, A.serial)
    const deposit = await depositToVault(phone, ADMIN, 250_000, { outputKeySerial: A.serial })
    const lock = await newLock(phone, world, deposit.txid)
    expect(lock.commitments).toEqual(await expectedCommitments(phone, lock.saltKeyId, [A, B]))
    expect(lock.commitments).toHaveLength(2)
    expect(lock.instructionSerials).toEqual(serials([A, B]))
    expect((await vaultStore.getMeta())!.staged).toEqual(X)
  })

  it('no tap from an existing key is requested by addVaultKey, and an unrelated re-lock (revokePubkey for another key) never includes the staged key', async () => {
    const world = await newWorld(4)
    const [A, B, D, X] = world.keys
    const phone = await enrolledPhone(world, [A, B, D], [500_000, 500_000])
    ;(requestVaultSigner as jest.Mock).mockClear()

    await addKeyThroughWizard(phone, X)
    expect(requestVaultSigner).not.toHaveBeenCalled()

    // The owner removes D. The removal re-lock does not pass activateStagedKey.
    armSigner(world.mock, A.serial)
    const removal = await beginVaultKeyRemoval(phone, ADMIN, D.serial)
    expect(removal.complete).toBe(false)
    const relock = await relockVault(phone, ADMIN, 'Remove key', A.serial, { revokePubkey: D.pubkey })
    const lock = await newLock(phone, world, relock.txid)
    expect(lock.instructionSerials).toEqual(serials([A, B]))
    expect(lock.commitments).toEqual(await expectedCommitments(phone, lock.saltKeyId, [A, B]))
    const meta = (await vaultStore.getMeta())!
    expect(serials(meta.keys)).toEqual(serials([A, B]))
    expect(meta.staged).toEqual(X)
  })

  it('funded vault: relockVault with activateStagedKey signed by an existing key commits the staged key, bumps the revision and clears staged; the old outputs open with the old keys; the new output opens with the new key', async () => {
    const world = await newWorld(3)
    const [A, B, C] = world.keys
    const phone = await enrolledPhone(world, [A, B], [500_000, 400_000])
    const oldTxids = phone
      .localVaultOutpoints()
      .map(o => o.split('.')[0])
      .sort()
    expect(oldTxids).toHaveLength(2)
    for (const txid of oldTxids) {
      const lockOld = await newLock(phone, world, txid)
      expect(lockOld.instructionSerials).toEqual(serials([A, B]))
    }
    await addKeyThroughWizard(phone, C)
    ;(requestVaultSigner as jest.Mock).mockClear()

    const relock = await relockVault(phone, ADMIN, 'Add key', A.serial, { activateStagedKey: C.serial })
    // Only the existing key was asked for (the output possession check and the spend).
    const asked = (requestVaultSigner as jest.Mock).mock.calls.map(c => c[1])
    expect(asked.length).toBeGreaterThan(0)
    expect(new Set(asked)).toEqual(new Set([A.serial]))
    // The old outputs, committed to {A,B} only, were opened by A.
    const spent = world.chain
      .tx(relock.txid)!
      .inputs.map(i => i.sourceTransaction!.id('hex'))
      .sort()
    expect(spent).toEqual(oldTxids)

    const lock = await newLock(phone, world, relock.txid)
    expect(lock.instructionSerials).toEqual(serials([A, B, C]))
    expect(lock.commitments).toEqual(await expectedCommitments(phone, lock.saltKeyId, [A, B, C]))
    expect(lock.revision).toBe(2)
    const meta = (await vaultStore.getMeta())!
    expect(serials(meta.keys)).toEqual(serials([A, B, C]))
    expect(meta.revision).toBe(2)
    expect(meta.staged).toBeUndefined()

    // The new output opens with the new key (real MockYubiKey signature).
    armSigner(world.mock, C.serial)
    const spend = await withdrawFromVault(phone, ADMIN, 'all', 'Withdraw with the new key', C.serial)
    expect(world.chain.tx(spend.txid)!.inputs.map(i => i.sourceTransaction!.id('hex'))).toEqual([relock.txid])
  })

  it('relockVault with activateStagedKey equal to another serial refuses (not-enrolled) before any tap; the key stays staged', async () => {
    const world = await newWorld(3)
    const [A, B, C] = world.keys
    const phone = await enrolledPhone(world, [A, B], [500_000])
    await addKeyThroughWizard(phone, C)
    ;(requestVaultSigner as jest.Mock).mockClear()
    const createAction = jest.spyOn(phone, 'createAction')

    await expect(relockVault(phone, ADMIN, 'Add key', A.serial, { activateStagedKey: B.serial })).rejects.toMatchObject(
      {
        code: 'not-enrolled'
      }
    )
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(createAction).not.toHaveBeenCalled()
    const meta = (await vaultStore.getMeta())!
    expect(meta.staged).toEqual(C)
    expect(serials(meta.keys)).toEqual(serials([A, B]))
  })

  it('a second addVaultKey while one is staged refuses with relock-required; discardStagedVaultKey clears it and the serial leaves the registry', async () => {
    const world = await newWorld(4)
    const [A, B, C, D] = world.keys
    const phone = await enrolledPhone(world, [A, B], [500_000])
    await addKeyThroughWizard(phone, C)
    expect(await enrolledSerialRegistry.has(C.serial)).toBe(true)

    await stageReadyDraft(phone, D)
    await expect(addVaultKey(D, undefined, authority(phone))).rejects.toMatchObject({ code: 'relock-required' })
    expect((await vaultStore.getMeta())!.staged).toEqual(C)
    ;(requestVaultSigner as jest.Mock).mockClear()
    const discarded = await discardStagedVaultKey(undefined, authority(phone))
    expect(discarded.staged).toBeUndefined()
    expect(requestVaultSigner).not.toHaveBeenCalled()
    const stored = (await vaultStore.getMeta())!
    expect(stored.staged).toBeUndefined()
    expect(serials(stored.keys)).toEqual(serials([A, B]))
    expect(stored.revision).toBe(1)
    expect(await enrolledSerialRegistry.has(C.serial)).toBe(false)

    // Nothing is staged now, so a second discard refuses.
    await expect(discardStagedVaultKey(undefined, authority(phone))).rejects.toMatchObject({ code: 'not-enrolled' })
    // The tag was rewritten: the stored meta still authenticates.
    const scope = vaultStore.getScope()!
    await expect(verifyVaultMetaAuthorityTag(phone, ADMIN, stored, scope, await vaultStore.getMetaTag())).resolves.toBe(
      true
    )
  })

  it('no funded output: activateStagedKeyWithoutOutputs needs the existing key tap for the chosen serial and promotes the key; an attacker without that tap cannot', async () => {
    const world = await newWorld(3)
    const [A, B, C] = world.keys
    const phone = await enrolledPhone(world, [A, B], [])
    await addKeyThroughWizard(phone, C)

    // Attacker: the signer request fails (no card), the key stays staged.
    ;(requestVaultSigner as jest.Mock).mockReset()
    ;(requestVaultSigner as jest.Mock).mockRejectedValue(new Error('no card'))
    await expect(activateStagedKeyWithoutOutputs(phone, ADMIN, A.serial)).rejects.toThrow('no card')
    let meta = (await vaultStore.getMeta())!
    expect(meta.staged).toEqual(C)
    expect(serials(meta.keys)).toEqual(serials([A, B]))
    expect(meta.revision).toBe(1)

    // A signer that answers with the wrong card is refused as well.
    armSigner(world.mock, B.serial)
    await expect(activateStagedKeyWithoutOutputs(phone, ADMIN, A.serial)).rejects.toThrow()
    expect((await vaultStore.getMeta())!.staged).toEqual(C)

    // The owner taps the existing key A.
    armSigner(world.mock, A.serial)
    const promoted = await activateStagedKeyWithoutOutputs(phone, ADMIN, A.serial)
    expect((requestVaultSigner as jest.Mock).mock.calls.some(c => c[1] === A.serial)).toBe(true)
    expect(serials(promoted.keys)).toEqual(serials([A, B, C]))
    expect(promoted.revision).toBe(2)
    expect(promoted.staged).toBeUndefined()
    meta = (await vaultStore.getMeta())!
    expect(serials(meta.keys)).toEqual(serials([A, B, C]))
    expect(meta.staged).toBeUndefined()
    const scope = vaultStore.getScope()!
    await expect(verifyVaultMetaAuthorityTag(phone, ADMIN, meta, scope, await vaultStore.getMetaTag())).resolves.toBe(
      true
    )

    // The next deposit commits all three.
    const deposit = await depositToVault(phone, ADMIN, 250_000, { outputKeySerial: A.serial })
    const lock = await newLock(phone, world, deposit.txid)
    expect(lock.instructionSerials).toEqual(serials([A, B, C]))
  })

  it('activateStagedKeyWithoutOutputs refuses a chosen key that no tap on this phone has proven (keys-unproven)', async () => {
    const world = await newWorld(3)
    const [A, B, C] = world.keys
    const phone = new FakeVaultWallet(world.primaryKey, world.chain)
    await seedOwnMeta(phone, {
      v: 6,
      vaultId: world.vaultId,
      revision: 2,
      createdAt: world.createdAt,
      keys: [A, B],
      staged: C,
      recovery: { required: true, adoptedSerials: [A.serial], adopted: [{ serial: A.serial, pubkey: A.pubkey }] }
    })
    armSigner(world.mock, B.serial)
    ;(requestVaultSigner as jest.Mock).mockClear()

    await expect(activateStagedKeyWithoutOutputs(phone, ADMIN, B.serial)).rejects.toMatchObject({
      code: 'keys-unproven',
      details: { serials: B.serial }
    })
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect((await vaultStore.getMeta())!.staged).toEqual(C)
  })

  it('activateStagedKeyWithoutOutputs refuses with relock-required when an output exists and with action-pending when a vault action is pending', async () => {
    const world = await newWorld(3)
    const [A, B, C] = world.keys
    const funded = await enrolledPhone(world, [A, B], [500_000])
    await addKeyThroughWizard(funded, C)
    armSigner(world.mock, A.serial)
    ;(requestVaultSigner as jest.Mock).mockClear()
    await expect(activateStagedKeyWithoutOutputs(funded, ADMIN, A.serial)).rejects.toMatchObject({
      code: 'relock-required'
    })
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect((await vaultStore.getMeta())!.staged).toEqual(C)

    // A second, empty wallet world with a signed-but-unbroadcast deposit (it would
    // create an output once sent).
    await AsyncStorage.clear()
    ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
    vaultStore.clearScope()
    vaultStore.configureScope({ identityKey, chain: 'test' })
    const empty = new FakeVaultWallet(generateMnemonicWallet().primaryKey, new FakeChain())
    await seedOwnMeta(empty, { v: 6, vaultId: world.vaultId, revision: 1, createdAt: world.createdAt, keys: [A, B] })
    await addKeyThroughWizard(empty, C)
    jest.spyOn(empty, 'listActions').mockImplementation(async () => ({
      actions: [{ reference: 'pending-ref', status: 'nosend', labels: ['vault', 'vault-deposit'] } as never],
      totalActions: 1
    }))
    ;(requestVaultSigner as jest.Mock).mockClear()
    await expect(activateStagedKeyWithoutOutputs(empty, ADMIN, A.serial)).rejects.toMatchObject({
      code: 'action-pending'
    })
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect((await vaultStore.getMeta())!.staged).toEqual(C)
  })

  it('sixth key: five keys plus a staged key is allowed; activation refuses with too-many-active-keys; a removal re-lock with revokePubkey and activateStagedKey together commits four plus one', async () => {
    const world = await newWorld(6)
    const [A, B, C, D, E, F] = world.keys
    const phone = await enrolledPhone(world, [A, B, C, D, E], [500_000])
    const staged = await addKeyThroughWizard(phone, F)
    expect(staged.staged).toEqual(F)
    expect(staged.keys).toHaveLength(5)

    // Activation alone would lock six keys.
    ;(requestVaultSigner as jest.Mock).mockClear()
    await expect(relockVault(phone, ADMIN, 'Add key', A.serial, { activateStagedKey: F.serial })).rejects.toMatchObject(
      {
        code: 'too-many-active-keys'
      }
    )
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect((await vaultStore.getMeta())!.staged).toEqual(F)

    // Without outputs the promotion has the same limit.
    // (Here an output exists, so the removal re-lock is the way.)
    armSigner(world.mock, A.serial)
    const removal = await beginVaultKeyRemoval(phone, ADMIN, E.serial)
    expect(removal.complete).toBe(false)
    const relock = await relockVault(phone, ADMIN, 'Replace key', A.serial, {
      revokePubkey: E.pubkey,
      activateStagedKey: F.serial
    })
    const lock = await newLock(phone, world, relock.txid)
    expect(lock.instructionSerials).toEqual(serials([A, B, C, D, F]))
    expect(lock.commitments).toEqual(await expectedCommitments(phone, lock.saltKeyId, [A, B, C, D, F]))
    const meta = (await vaultStore.getMeta())!
    expect(serials(meta.keys)).toEqual(serials([A, B, C, D, F]))
    expect(meta.staged).toBeUndefined()
    // The removal itself finishes later, when a scan proves no lock still names E.
    expect(meta.pendingRemoval).toMatchObject({ state: 'broadcast', key: { serial: E.serial } })
  })

  it('sixth key without outputs: activateStagedKeyWithoutOutputs refuses with too-many-active-keys', async () => {
    const world = await newWorld(6)
    const [A, B, C, D, E, F] = world.keys
    const phone = await enrolledPhone(world, [A, B, C, D, E], [])
    await addKeyThroughWizard(phone, F)
    armSigner(world.mock, A.serial)
    ;(requestVaultSigner as jest.Mock).mockClear()
    await expect(activateStagedKeyWithoutOutputs(phone, ADMIN, A.serial)).rejects.toMatchObject({
      code: 'too-many-active-keys'
    })
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect((await vaultStore.getMeta())!.staged).toEqual(F)
  })

  it('vault too small to re-lock: relockVault with activateStagedKey throws too-small-to-relock and the key stays staged', async () => {
    const world = await newWorld(3)
    const [A, B, C] = world.keys
    const phone = await enrolledPhone(world, [A, B], [100_000])
    await addKeyThroughWizard(phone, C)
    ;(requestVaultSigner as jest.Mock).mockClear()
    const createAction = jest.spyOn(phone, 'createAction')

    await expect(relockVault(phone, ADMIN, 'Add key', A.serial, { activateStagedKey: C.serial })).rejects.toMatchObject(
      {
        code: 'too-small-to-relock'
      }
    )
    expect(createAction).not.toHaveBeenCalled()
    const meta = (await vaultStore.getMeta())!
    expect(meta.staged).toEqual(C)
    expect(serials(meta.keys)).toEqual(serials([A, B]))
    expect(meta.revision).toBe(1)
  })

  it('crash after broadcast: the local commit fails, then recoverVaultMetaFromOutputs supersedes (all keys known) and staged is gone', async () => {
    const world = await newWorld(3)
    const [A, B, C] = world.keys
    const phone = await enrolledPhone(world, [A, B], [500_000])
    await addKeyThroughWizard(phone, C)
    jest.spyOn(vaultStore, 'commitLockKeySet').mockRejectedValueOnce(new Error('disk full'))

    await expect(relockVault(phone, ADMIN, 'Add key', A.serial, { activateStagedKey: C.serial })).rejects.toThrow(
      'disk full'
    )
    const stale = (await vaultStore.getMeta())!
    expect(stale.staged).toEqual(C)
    expect(stale.revision).toBe(1)

    await recoverVaultMetaFromOutputs(phone, ADMIN)
    const meta = (await vaultStore.getMeta())!
    expect(serials(meta.keys)).toEqual(serials([A, B, C]))
    expect(meta.revision).toBe(2)
    expect(meta.staged).toBeUndefined()
  })

  it('the staged key is covered by the meta authority tag: removing meta.staged in SecureStore makes requireAuthenticatedMeta fall back to the chain check', async () => {
    const world = await newWorld(3)
    const [A, B, C] = world.keys
    const phone = await enrolledPhone(world, [A, B], [500_000])
    const staged = await addKeyThroughWizard(phone, C)
    const scopeToken = vaultStore.captureScopeToken()
    const scope = vaultStore.getScope()!
    const tagBefore = await vaultStore.getMetaTag()
    await expect(verifyVaultMetaAuthorityTag(phone, ADMIN, staged, scope, tagBefore)).resolves.toBe(true)

    // Store-only edit: staged removed, tag untouched.
    const { staged: _removed, ...withoutStaged } = staged
    await vaultStore.setMeta(withoutStaged)
    await expect(
      verifyVaultMetaAuthorityTag(phone, ADMIN, withoutStaged, scope, await vaultStore.getMetaTag())
    ).resolves.toBe(false)

    // The chain check (a funded vault) accepts the unchanged key list and
    // re-tags; the tag therefore changes.
    const authenticated = await requireAuthenticatedMeta(phone, ADMIN, scopeToken, (await vaultStore.getMeta())!)
    expect(serials(authenticated.keys)).toEqual(serials([A, B]))
    expect(await vaultStore.getMetaTag()).not.toEqual(tagBefore)
  })

  it('a forged staged key written to SecureStore does not enter a lock: the edit voids the adoption proof, and a re-lock with the forged staged serial refuses', async () => {
    const world = await newWorld(4)
    const [A, B, C, X] = world.keys
    const phone = await enrolledPhone(world, [A, B], [500_000])
    const staged = await addKeyThroughWizard(phone, C)
    await vaultStore.setMeta({ ...staged, staged: X })
    armSigner(world.mock, A.serial)
    ;(requestVaultSigner as jest.Mock).mockClear()
    const createAction = jest.spyOn(phone, 'createAction')

    // The tag no longer matches, so the chain check restores the authentic key
    // list and drops the forged staged key. It also marks the phone as needing
    // a fresh tap of every key (nothing is proven any more): no spend starts.
    await expect(relockVault(phone, ADMIN, 'Add key', A.serial, { activateStagedKey: X.serial })).rejects.toMatchObject(
      {
        code: 'key-not-adopted'
      }
    )
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(createAction).not.toHaveBeenCalled()
    const meta = (await vaultStore.getMeta())!
    expect(meta.staged).toBeUndefined()
    expect(serials(meta.keys)).toEqual(serials([A, B]))

    // After the owner taps A, the forged serial still refuses: it is not staged.
    await adoptVaultKey({ record: A, onPhase: () => {}, getPin: async () => '123456' })
    await expect(relockVault(phone, ADMIN, 'Add key', A.serial, { activateStagedKey: X.serial })).rejects.toMatchObject(
      {
        code: 'not-enrolled'
      }
    )
    expect(createAction).not.toHaveBeenCalled()
    expect(serials((await vaultStore.getMeta())!.keys)).toEqual(serials([A, B]))
  })
})
