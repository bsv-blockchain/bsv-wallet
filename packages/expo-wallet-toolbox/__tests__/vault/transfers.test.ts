/**
 * Vault transfers tests.
 *
 * The cryptographic arbiter for the R1C script itself lives in r1comb.test.ts
 * (goldens, Spend round trips, negatives). This file is orchestration: the
 * deposit's gates and output shape, coin selection, the commitment check
 * against the REAL lock, sequential on-card signing through a fake signer,
 * abort-on-failure, signer release, and double-spend heal — validated against
 * a fake VaultWallet whose signable transactions are real @bsv/sdk
 * Transactions, so every unlocking script the withdraw path produces is
 * checked by the real interpreter under the strict flags.
 *
 * Plan 1's r1comb.ts must exist.
 */
import { Beef, BigNumber, ECDSA, LockingScript, P2PKH, PrivateKey, Spend, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import {
  R1C_LOCK_LEN,
  R1C_UNLOCK_LEN,
  bakedCommitments,
  buildLock,
  commitment,
  decodeVaultInstructions,
  encodeVaultInstructions,
  sighashPreimage,
  signerDigest,
  verifyVaultInput
} from '../../core/services/vault/r1comb'
// Namespace import so single functions can be spied (Babel's CJS interop
// reads exports at call time, so a spyOn here is seen by transfers.ts).
import * as r1comb from '../../core/services/vault/r1comb'

// Own AsyncStorage mock, matching __tests__/backup/erase.test.ts: the vault
// suites install a different one and a global mapper makes the resolver
// recurse between the two.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => { for (const k of keys) delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {})
}))

// The ceremony is a process singleton wired to the native driver; here it is a
// jest.fn the withdraw suites arm with a software P-256 key (see armWith).
jest.mock('../../core/services/vault/ceremonyHost', () => ({
  requestVaultSigner: jest.fn(),
  noteVaultProgress: jest.fn()
}))
// The two default gates. transfers.ts reads them only when opts omit the
// injected ones; both are asserted below, so they are mocked rather than left
// to configureToolbox / AsyncStorage state.
jest.mock('../../core/toolboxConfig', () => ({
  isVaultEnabled: jest.fn(() => true)
}))
jest.mock('../../core/backup/preference', () => ({
  isBackupPushEnabled: jest.fn(async () => true)
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import { isBackupPushEnabled } from '../../core/backup/preference'
import { isVaultEnabled } from '../../core/toolboxConfig'
import { noteVaultProgress, requestVaultSigner } from '../../core/services/vault/ceremonyHost'
import { vaultStore, VaultKeyRecord } from '../../core/services/vault/vaultStore'
import type { VaultSigner } from '../../core/services/vault/ceremony'
import { VaultError } from '../../core/services/vault/types'
import {
  VAULT_BASKET,
  VAULT_DEPOSIT_MIN,
  VAULT_HARD_MAX_INPUTS,
  VAULT_MAX_INPUTS,
  VAULT_STAGING_BASKET,
  VaultWallet,
  depositToVault,
  estimateRelockFee,
  getVaultBalance,
  getVaultKeyCoverage,
  orphanedIfRemoved,
  previewVaultWithdrawal,
  reclaimStagingOutputs,
  relockVault,
  withdrawFromVault
} from '../../core/services/vault/transfers'

const ADMIN = 'admin.com'

// Two software P-256 keys standing in for two enrolled YubiKeys, generated
// once for the whole file. Their compressed pubkeys are what meta v5 records;
// the private halves let the withdraw suites' fake signer produce real
// signatures the R1C lock accepts.
const PRIV_A = p256.utils.randomSecretKey()
const PRIV_B = p256.utils.randomSecretKey()
const PUB_A = Utils.toHex(Array.from(p256.getPublicKey(PRIV_A, true)))
const PUB_B = Utils.toHex(Array.from(p256.getPublicKey(PRIV_B, true)))
const KEY_A: VaultKeyRecord = { serial: 'A-1', slot: 0x82, pubkey: PUB_A, nickname: 'Desk', enrolledAt: 1 }
const KEY_B: VaultKeyRecord = { serial: 'B-1', slot: 0x82, pubkey: PUB_B, nickname: 'Safe', enrolledAt: 2 }
/** A third enrolled key nobody signs with here. */
const KEY_C: VaultKeyRecord = {
  serial: 'C-1',
  slot: 0x82,
  pubkey: Utils.toHex(Array.from(p256.getPublicKey(p256.utils.randomSecretKey(), true))),
  nickname: 'Parents',
  enrolledAt: 3
}

async function seedMeta(keys: VaultKeyRecord[] = [KEY_A, KEY_B]): Promise<void> {
  await vaultStore.setMeta({ v: 5, createdAt: 1, keys })
}

/** A BEEF carrying every fixture's raw source transaction, as listOutputs
 * with `include: 'entire transactions'` returns. It is load-bearing twice
 * over: createAction's signer layer (buildSignableTransaction) resolves each
 * input's sourceTransaction ONLY from this BEEF, and the withdraw path reads
 * each vault output's REAL locking script out of it for the commitment check. */
const stitchBeef = (fx: { src: Transaction }[]): number[] => {
  const beef = new Beef()
  for (const { src } of fx) beef.mergeRawTx(src.toBinary())
  return beef.toBinary()
}

// ── fake wallet ───────────────────────────────────────────────────────────

let wallet: VaultWallet & {
  createAction: jest.Mock
  signAction: jest.Mock
  listOutputs: jest.Mock
  getPublicKey: jest.Mock
  createSignature: jest.Mock
  abortAction: jest.Mock
  listActions: jest.Mock
}

/** Staging outputs the fake wallet "holds" — legacy strands from the retired
 * two-transaction deposit, served to reclaimStagingOutputs' listOutputs call.
 * Nothing mints these any more; reclaim tests seed them directly. */
let fakeStagingUtxos: { outpoint: string; satoshis: number; customInstructions?: string }[]

beforeEach(async () => {
  await AsyncStorage.clear()
  fakeStagingUtxos = []
  wallet = {
    // Default: one call builds, signs and broadcasts — the single-transaction
    // deposit shape (no signableTransaction comes back when the caller
    // supplies no inputs of its own).
    createAction: jest.fn(async () => ({ txid: 'deadbeef'.repeat(8) })),
    signAction: jest.fn(async () => ({ txid: 'feedface'.repeat(8) })),
    listOutputs: jest.fn(async (args: any) =>
      args?.basket === VAULT_STAGING_BASKET ? { outputs: [...fakeStagingUtxos] } : { outputs: [] }
    ),
    // Legacy reclaim only. The staging derivation parses this as a curve
    // point, so it needs a real one (compressed secp256k1 G).
    getPublicKey: jest.fn(async () => ({
      publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    })),
    createSignature: jest.fn(async () => ({ signature: new Array(70).fill(1) })),
    abortAction: jest.fn(async () => ({})),
    listActions: jest.fn(async () => ({ actions: [] }))
  }
  ;(isVaultEnabled as jest.Mock).mockReturnValue(true)
  ;(isBackupPushEnabled as jest.Mock).mockResolvedValue(true)
  ;(noteVaultProgress as jest.Mock).mockClear()
  ;(requestVaultSigner as jest.Mock).mockReset()
  lastSignable = undefined
  signerRelease = jest.fn()
  signCalls = []
  armWith(PRIV_A, PUB_A, 'A-1')
})

// Spies on r1comb (Task 10 stubs verifyVaultInput / pushTxDerCheck in a few
// tests) must not leak between tests: a stubbed verifyVaultInput would let a
// later "the interpreter accepts it" test pass vacuously. Everything the
// beforeEach above creates or re-arms survives this.
afterEach(() => jest.restoreAllMocks())

// ── withdraw fixtures ─────────────────────────────────────────────────────

interface VaultFixture {
  outpoint: string
  satoshis: number
  salt: string
  keys: string[]
  lockingScript: LockingScript
  src: Transaction
  customInstructions: string
}

/**
 * A real R1C vault output: fresh salt, lock committed to `lockKeys`, and a v4
 * record claiming `keys`. The two agree unless a test says otherwise (the
 * key-not-committed case bakes a lock the record lies about).
 */
function vaultFixture(satoshis: number, keys: string[], lockKeys: string[] = keys): VaultFixture {
  const salt = Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(32))))
  const lockingScript = buildLock({ commitments: lockKeys.map(pk => commitment(pk, salt)) })
  const src = new Transaction()
  src.addOutput({ satoshis, lockingScript })
  return {
    outpoint: `${src.id('hex')}.0`,
    satoshis,
    salt,
    keys,
    lockingScript,
    src,
    customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt, keys })
  }
}

/** The signable transaction the fake wallet last fabricated — the object the
 * real interpreter checks each unlocking script against. */
let lastSignable: Transaction | undefined

/**
 * Serve `fx` from the fake wallet and fabricate a REAL signable transaction of
 * whatever version the caller asks for, honouring per-input sequenceNumber,
 * with the toolbox's own change output appended. `fundingFirst` prepends a
 * funding input, as the toolbox may — the code under test must locate its
 * inputs by outpoint, never by position.
 */
async function seedVault(
  fx: VaultFixture[],
  keys: VaultKeyRecord[] = [KEY_A, KEY_B],
  opts: { fundingFirst?: boolean } = {}
): Promise<void> {
  await seedMeta(keys)
  wallet.listOutputs.mockImplementation(async (args: any) =>
    args?.basket === VAULT_BASKET
      ? {
          outputs: fx.map(f => ({ outpoint: f.outpoint, satoshis: f.satoshis, customInstructions: f.customInstructions })),
          BEEF: stitchBeef(fx)
        }
      : args?.basket === VAULT_STAGING_BASKET
        ? { outputs: [...fakeStagingUtxos] }
        : { outputs: [] }
  )
  wallet.createAction.mockImplementation(async (args: any) => {
    const tx = new Transaction(args.version ?? 1)
    if (opts.fundingFirst) {
      const fund = new Transaction()
      fund.addOutput({ satoshis: 50_000, lockingScript: new P2PKH().lock(Utils.toArray('44'.repeat(20), 'hex')) })
      tx.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
    }
    for (const inp of args.inputs ?? []) {
      const f = fx.find(x => x.outpoint === inp.outpoint)!
      tx.addInput({
        sourceTransaction: f.src,
        sourceOutputIndex: 0,
        sequence: inp.sequenceNumber ?? 0xffffffff,
        unlockingScript: new UnlockingScript([])
      })
    }
    for (const out of args.outputs ?? []) {
      tx.addOutput({ satoshis: out.satoshis, lockingScript: LockingScript.fromHex(out.lockingScript) })
    }
    // The toolbox's own default-basket change.
    tx.addOutput({ satoshis: 1234, lockingScript: new P2PKH().lock(Utils.toArray('11'.repeat(20), 'hex')) })
    lastSignable = tx
    return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-1' } }
  })
}

let signerRelease: jest.Mock
let signCalls: { digest: string; progress?: { index: number; total: number } }[]

/**
 * Arm the mocked ceremonyHost with a software key standing in for a YubiKey.
 * Mirrors the real requestVaultSigner contract: refuses a chosenSerial that is
 * not this key (serial-mismatch), signs raw 32-byte digests as DER WITHOUT
 * low-S normalisation (real PIV hardware does not normalise; the lock accepts
 * both), and refuses to sign after release.
 */
const armWith = (priv: Uint8Array, pubkey: string, serial: string): void => {
  ;(requestVaultSigner as jest.Mock).mockImplementation(async (_reason: string, chosenSerial: string) => {
    if (chosenSerial !== serial) {
      throw new VaultError('serial-mismatch', `Tapped key ${serial}, chose key ${chosenSerial}`)
    }
    let released = false
    const signer: VaultSigner = {
      serial,
      pubkey,
      sign: async (digestHex, progress) => {
        if (released) throw new VaultError('key-removed-mid-op', 'Vault signer already released')
        signCalls.push({ digest: digestHex, progress })
        const raw = p256.sign(Uint8Array.from(Utils.toArray(digestHex, 'hex')), priv, { prehash: false, lowS: false })
        return Array.from(p256.Signature.fromBytes(raw).toBytes('der'))
      },
      release: () => {
        if (released) return
        released = true
        signerRelease()
      }
    }
    return signer
  })
}

/** Every produced unlock, checked by the real interpreter under the strict
 * flags against the fake's real v2 transaction. */
const validateSpends = (fx: VaultFixture[]): void => {
  const [caArgs] = wallet.createAction.mock.calls.at(-1)!
  const [saArgs] = wallet.signAction.mock.calls[0]
  const tx = lastSignable!
  expect(Object.keys(saArgs.spends)).toHaveLength(caArgs.inputs.length)
  for (const inp of caArgs.inputs as { outpoint: string }[]) {
    const f = fx.find(x => x.outpoint === inp.outpoint)!
    const idx = tx.inputs.findIndex(i => i.sourceTransaction?.id('hex') === f.src.id('hex'))
    expect(idx).toBeGreaterThanOrEqual(0)
    const unlockingScript = UnlockingScript.fromHex(saArgs.spends[idx].unlockingScript)
    expect(unlockingScript.toBinary().length).toBeLessThanOrEqual(R1C_UNLOCK_LEN)
    expect(
      verifyVaultInput({ tx, inputIndex: idx, sourceSatoshis: f.satoshis, lockingScript: f.lockingScript, unlockingScript })
    ).toBe(true)
  }
}

const withdrawAll = (opts?: Parameters<typeof withdrawFromVault>[5]) =>
  withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all', 'A-1', opts)

// ── deposit ───────────────────────────────────────────────────────────────

describe('depositToVault', () => {
  const depositArgs = () => wallet.createAction.mock.calls[0][0] as any

  it('moves the deposit in ONE ordinary version-1 transaction: no inputs of ours, no signAction, no hardware', async () => {
    await seedMeta()
    const { txid } = await depositToVault(wallet, ADMIN, 250_000)
    expect(txid).toBe('deadbeef'.repeat(8))

    // Exactly one createAction — the two-transaction staging deposit is gone.
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    const args = depositArgs()
    expect(args.version).toBeUndefined() // deposits stay at the default version 1 (spec §2.6)
    expect(args.inputs).toBeUndefined() // funding is the toolbox's own coin selection
    expect(args.inputBEEF).toBeUndefined()
    expect(args.description).toBe('Vault deposit')
    // The label is load-bearing: the patched toolbox suppresses UTXO-pool
    // growth for 'vault-deposit', keeping the deposit shape minimal.
    expect(args.labels).toEqual(['vault', 'vault-deposit'])
    expect(args.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false })
    expect(args.outputs).toHaveLength(1)
    expect(args.outputs[0]).toMatchObject({
      satoshis: 250_000,
      basket: VAULT_BASKET,
      outputDescription: 'Vault deposit',
      tags: ['vault']
    })

    // No hardware, no ceremony, no progress sheet, no identity lookup.
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(noteVaultProgress).not.toHaveBeenCalled()
    expect(wallet.getPublicKey).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(wallet.createSignature).not.toHaveBeenCalled()
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('locks to a fresh 32-byte salt committed to EVERY enrolled key, and records salt + keys as v4 customInstructions', async () => {
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000)
    const out = depositArgs().outputs[0]

    // The R1C lock for two keys, byte-exact in length.
    expect(Utils.toArray(out.lockingScript, 'hex')).toHaveLength(R1C_LOCK_LEN(2))

    const ci = decodeVaultInstructions(out.customInstructions)!
    expect(ci).not.toBeNull()
    expect(ci.v).toBe(4)
    expect(ci.type).toBe('R1C')
    expect(ci.salt).toMatch(/^[0-9a-f]{64}$/)
    expect(ci.keys).toEqual([PUB_A, PUB_B]) // commitment order = meta order

    // The lock really bakes both commitments, in that order — not just the
    // record claiming so.
    expect(bakedCommitments(LockingScript.fromHex(out.lockingScript))).toEqual([
      commitment(PUB_A, ci.salt),
      commitment(PUB_B, ci.salt)
    ])
  })

  it('uses a different salt (and so a different lock) for every deposit', async () => {
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000)
    await depositToVault(wallet, ADMIN, 250_000)
    const outs = wallet.createAction.mock.calls.map(([a]: [any]) => a.outputs[0])
    const salts = outs.map((o: any) => decodeVaultInstructions(o.customInstructions)!.salt)
    expect(salts[0]).not.toBe(salts[1])
    expect(outs[0].lockingScript).not.toBe(outs[1].lockingScript)
  })

  it('commits to the CURRENT key list — three keys, three commitments, the three-key lock length', async () => {
    await seedMeta([KEY_A, KEY_B, KEY_C])
    await depositToVault(wallet, ADMIN, 250_000)
    const out = depositArgs().outputs[0]
    expect(Utils.toArray(out.lockingScript, 'hex')).toHaveLength(R1C_LOCK_LEN(3))
    const ci = decodeVaultInstructions(out.customInstructions)!
    expect(ci.keys).toEqual([PUB_A, PUB_B, KEY_C.pubkey])
    expect(bakedCommitments(LockingScript.fromHex(out.lockingScript))).toHaveLength(3)
  })

  it('accepts exactly the floor', async () => {
    await seedMeta()
    expect(VAULT_DEPOSIT_MIN).toBe(100_000)
    await expect(depositToVault(wallet, ADMIN, VAULT_DEPOSIT_MIN)).resolves.toMatchObject({ txid: expect.any(String) })
  })

  describe('gates — every refusal before any money moves', () => {
    it('not-released when the injected flag is off, before anything else is consulted', async () => {
      await seedMeta()
      const isOnline = jest.fn(async () => true)
      const backupEnabled = jest.fn(async () => true)
      await expect(
        depositToVault(wallet, ADMIN, 250_000, { vaultEnabled: () => false, isOnline, backupEnabled })
      ).rejects.toMatchObject({ code: 'not-released' })
      expect(isOnline).not.toHaveBeenCalled()
      expect(backupEnabled).not.toHaveBeenCalled()
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('reads isVaultEnabled() when opts omit the flag', async () => {
      await seedMeta()
      ;(isVaultEnabled as jest.Mock).mockReturnValueOnce(false)
      await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'not-released' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('below-dust under VAULT_DEPOSIT_MIN, and for a non-integer amount', async () => {
      await seedMeta()
      await expect(depositToVault(wallet, ADMIN, VAULT_DEPOSIT_MIN - 1)).rejects.toMatchObject({ code: 'below-dust' })
      await expect(depositToVault(wallet, ADMIN, 250_000.5)).rejects.toMatchObject({ code: 'below-dust' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('requires-online before the backup or key checks', async () => {
      await seedMeta()
      const backupEnabled = jest.fn(async () => true)
      await expect(
        depositToVault(wallet, ADMIN, 250_000, { isOnline: async () => false, backupEnabled })
      ).rejects.toMatchObject({ code: 'requires-online' })
      expect(backupEnabled).not.toHaveBeenCalled()
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('backup-off when the injected backup gate is off (D13)', async () => {
      await seedMeta()
      await expect(
        depositToVault(wallet, ADMIN, 250_000, { backupEnabled: async () => false })
      ).rejects.toMatchObject({ code: 'backup-off' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('reads isBackupPushEnabled() when opts omit the gate', async () => {
      await seedMeta()
      ;(isBackupPushEnabled as jest.Mock).mockResolvedValueOnce(false)
      await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'backup-off' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('not-enrolled with no key list', async () => {
      await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'not-enrolled' })
    })

    it('not-enough-keys with a single enrolled key (defensive — the wizard cannot persist one)', async () => {
      await seedMeta([KEY_A])
      await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'not-enough-keys' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })
  })

  it('no-transaction when the wallet returns neither a txid nor a tx', async () => {
    await seedMeta()
    wallet.createAction.mockResolvedValueOnce({})
    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'no-transaction' })
  })
})

// ── legacy staging reclaim ────────────────────────────────────────────────

describe('reclaimStagingOutputs', () => {
  it('returns zero and touches nothing when the staging basket is empty', async () => {
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r).toEqual({ reclaimed: 0, satoshis: 0 })
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
    // No ceremony either — staging keys are ordinary wallet keys.
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('runs the storage heal BEFORE listing, so spendable=0 strands become visible', async () => {
    const stranded = {
      outpoint: `${'cd'.repeat(32)}.0`,
      satoshis: 250_017,
      customInstructions: JSON.stringify({ v: 1, type: 'staging', keyID: 'staging cafebabe' })
    }
    // The heal makes the stranded output visible again (spendable=1), which
    // the fake models by inserting it into the listable set.
    const releaseStrandedStaging = jest.fn(async () => {
      fakeStagingUtxos.push(stranded)
      return 1
    })
    const r = await reclaimStagingOutputs(wallet, ADMIN, { releaseStrandedStaging })
    expect(releaseStrandedStaging).toHaveBeenCalledTimes(1)
    expect(releaseStrandedStaging.mock.invocationCallOrder[0]).toBeLessThan(
      wallet.listOutputs.mock.invocationCallOrder[0]
    )
    expect(r.reclaimed).toBe(1)
    expect(r.satoshis).toBe(250_017)
    // Direct-txid branch (no signableTransaction came back): the txid is
    // plumbed through and nothing needed our signature.
    expect(r.txid).toBe('deadbeef'.repeat(8))
    expect(wallet.signAction).not.toHaveBeenCalled()
    const [args] = wallet.createAction.mock.calls[0]
    expect(args.inputs).toHaveLength(1)
    expect(args.inputs[0].outpoint).toBe(stranded.outpoint)
  })

  it('sweeps every decodable staging output regardless of amount, skipping undecodable ones', async () => {
    fakeStagingUtxos.push(
      { outpoint: `${'ab'.repeat(32)}.0`, satoshis: 250_017, customInstructions: JSON.stringify({ v: 1, type: 'staging', keyID: 'staging aaaa' }) },
      { outpoint: `${'cd'.repeat(32)}.1`, satoshis: 99_999, customInstructions: JSON.stringify({ v: 1, type: 'staging', keyID: 'staging bbbb' }) },
      { outpoint: `${'ef'.repeat(32)}.0`, satoshis: 12_345, customInstructions: 'not json at all' }
    )
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.reclaimed).toBe(2)
    expect(r.satoshis).toBe(250_017 + 99_999)
    const [args] = wallet.createAction.mock.calls[0]
    expect(args.inputs.map((i: any) => i.outpoint)).toEqual([`${'ab'.repeat(32)}.0`, `${'cd'.repeat(32)}.1`])
    // The reclaim keeps nothing: no outputs of its own, so the whole value
    // (minus fee) returns as toolbox change to the default basket.
    expect(args.outputs).toEqual([])
    // 'vault-deposit' is load-bearing: RELEASE_STRANDED_VAULT_STAGING_SQL's
    // predicate matches it, so a reclaim that itself fails at broadcast is
    // healed by the same release next time.
    expect(args.labels).toEqual(expect.arrayContaining(['vault', 'vault-deposit', 'vault-reclaim']))
  })

  /**
   * The production 2026-08-21 failure, migrated from the retired two-tx
   * deposit: generateChange's UTXO-pool growth added a funding input and
   * change outputs, and a staging signature built with `otherInputs: []`
   * committed to a one-input transaction. Every broadcaster rejected the
   * result with "false stack entry at end of script execution". Each staging
   * unlock must verify against the REAL interpreter for whatever transaction
   * shape the toolbox hands back.
   */
  const realReclaimWallet = (opts: { stagingFirst: boolean; coins?: number }) => {
    const coins = Array.from({ length: opts.coins ?? 1 }, (_, k) => {
      const priv = PrivateKey.fromRandom()
      const sats = 250_017 + k * 12_345
      const lock = new P2PKH().lock(priv.toPublicKey().toAddress())
      const src = new Transaction()
      src.addOutput({ satoshis: sats, lockingScript: lock })
      return {
        priv,
        pub: priv.toPublicKey().toString(),
        sats,
        lock,
        src,
        keyID: `staging c0ffee0${k}`,
        out: {
          outpoint: `${src.id('hex')}.0`,
          satoshis: sats,
          customInstructions: JSON.stringify({ v: 1, type: 'staging', keyID: `staging c0ffee0${k}` })
        }
      }
    })
    const fundPriv = PrivateKey.fromRandom()
    const fundSrc = new Transaction()
    fundSrc.addOutput({ satoshis: 12_730, lockingScript: new P2PKH().lock(fundPriv.toPublicKey().toAddress()) })

    wallet.listOutputs.mockImplementation(async (args: any) =>
      args?.basket === VAULT_STAGING_BASKET
        ? { outputs: coins.map(c => c.out), BEEF: stitchBeef(coins) }
        : { outputs: [] }
    )
    wallet.getPublicKey.mockImplementation(async (args: any) => ({
      publicKey: coins.find(c => c.keyID === args.keyID)!.pub
    }))
    // Sign the digest for real: the wallet signs hashToDirectlySign raw, and
    // the interpreter's OP_CHECKSIG later re-derives that digest itself.
    wallet.createSignature.mockImplementation(async (args: any) => {
      const c = coins.find(cc => cc.keyID === args.keyID)!
      const sig = ECDSA.sign(new BigNumber(args.hashToDirectlySign), c.priv, true)
      return { signature: sig.toDER() as number[] }
    })

    let signable: Transaction | undefined
    wallet.createAction.mockImplementation(async () => {
      const tx = new Transaction()
      // Non-default sequence and lockTime, deliberately: the preimage must
      // read BOTH from the transaction (transfers.ts formats with
      // input.sequence ?? 0xffffffff and tx.lockTime). A regression that
      // hardcodes the defaults would sign the wrong digest — the exact
      // "false stack entry" production failure class — and all-default
      // fixtures would never catch it.
      const addStaging = () => {
        for (const c of coins) {
          tx.addInput({ sourceTransaction: c.src, sourceOutputIndex: 0, sequence: 0xfffffffe, unlockingScript: new UnlockingScript([]) })
        }
      }
      const addFunding = () =>
        tx.addInput({ sourceTransaction: fundSrc, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
      if (opts.stagingFirst) {
        addStaging()
        addFunding()
      } else {
        addFunding()
        addStaging()
      }
      // The change outputs the toolbox generates (a reclaim has none of its own).
      tx.addOutput({ satoshis: 5000, lockingScript: new P2PKH().lock(Utils.toArray('22'.repeat(20), 'hex')) })
      tx.addOutput({ satoshis: 7000, lockingScript: new P2PKH().lock(Utils.toArray('33'.repeat(20), 'hex')) })
      tx.lockTime = 700_000
      signable = tx
      return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-rec' } }
    })
    return { coins, tx: () => signable! }
  }

  const validateReclaimSpends = (f: ReturnType<typeof realReclaimWallet>) => {
    const [signArgs] = wallet.signAction.mock.calls[0]
    expect(signArgs.reference).toBe('ref-rec')
    // Undelayed, pinned: a reclaim must not report success while its
    // transaction sits in the monitor queue with the broadcast still pending.
    expect(signArgs.options).toMatchObject({ acceptDelayedBroadcast: false })
    const tx = f.tx()
    for (const c of f.coins) {
      const idx = tx.inputs.findIndex(i => i.sourceTransaction?.id('hex') === c.src.id('hex'))
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(signArgs.spends[idx]).toBeDefined()
      const ok = new Spend({
        sourceTXID: c.src.id('hex'),
        sourceOutputIndex: 0,
        sourceSatoshis: c.sats,
        lockingScript: c.lock,
        transactionVersion: tx.version,
        otherInputs: tx.inputs.filter((_, i) => i !== idx),
        inputIndex: idx,
        unlockingScript: UnlockingScript.fromHex(signArgs.spends[idx].unlockingScript),
        outputs: tx.outputs,
        inputSequence: tx.inputs[idx].sequence ?? 0xffffffff,
        lockTime: tx.lockTime
      }).validate()
      expect(ok).toBe(true)
    }
    expect(Object.keys(signArgs.spends)).toHaveLength(f.coins.length)
  }

  it('signs a VALID reclaim when the toolbox adds a funding input and change outputs', async () => {
    const f = realReclaimWallet({ stagingFirst: true })
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.txid).toBe('feedface'.repeat(8))
    expect(r.reclaimed).toBe(1)
    validateReclaimSpends(f)
  })

  it('finds each staging input by outpoint even when none of them is input 0', async () => {
    const f = realReclaimWallet({ stagingFirst: false, coins: 2 })
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.reclaimed).toBe(2)
    validateReclaimSpends(f)
  })

  it('signs every staging coin with its OWN key, all valid under the real interpreter', async () => {
    const f = realReclaimWallet({ stagingFirst: true, coins: 3 })
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.reclaimed).toBe(3)
    expect(r.satoshis).toBe(f.coins.reduce((s, c) => s + c.sats, 0))
    validateReclaimSpends(f)
  })

  it('aborts the reservation when signing fails, so the coins stay reclaimable', async () => {
    realReclaimWallet({ stagingFirst: true })
    wallet.createSignature.mockRejectedValueOnce(new Error('deriver down'))
    await expect(reclaimStagingOutputs(wallet, ADMIN)).rejects.toThrow('deriver down')
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-rec' }, ADMIN)
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('forwards the listed BEEF as inputBEEF — the signer resolves sources only from it', async () => {
    realReclaimWallet({ stagingFirst: true })
    await reclaimStagingOutputs(wallet, ADMIN)
    // The listOutputs args are load-bearing: without includeCustomInstructions
    // every coin decodes as null and the reclaim silently recovers NOTHING;
    // without 'entire transactions' there is no BEEF and the signer throws.
    const [listArgs] = wallet.listOutputs.mock.calls[0]
    expect(listArgs.basket).toBe(VAULT_STAGING_BASKET)
    expect(listArgs.include).toBe('entire transactions')
    expect(listArgs.includeCustomInstructions).toBe(true)
    const [args] = wallet.createAction.mock.calls[0]
    expect(Array.isArray(args.inputBEEF)).toBe(true)
    expect(args.inputBEEF.length).toBeGreaterThan(0)
    expect(args.options).toMatchObject({ acceptDelayedBroadcast: false, trustSelf: 'known' })
  })

  it('heals a stuck reservation (review-actions refusal) by aborting the orphan and retrying once', async () => {
    // A prior crashed reclaim/deposit left the coin's spentBy pointing at an
    // orphaned transaction; createAction refuses with WERR_REVIEW_ACTIONS.
    // The reclaim must free the orphan (same machinery as the withdraw path)
    // and retry once, not surface the refusal to a fire-and-forget caller.
    const f = realReclaimWallet({ stagingFirst: true })
    const orphanTxid = '9a'.repeat(32)
    const reviewErr = Object.assign(new Error('actions require review'), {
      reviewActionResults: [{ competingTxs: [orphanTxid] }]
    })
    const inner = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementationOnce(async () => {
      throw reviewErr
    })
    wallet.createAction.mockImplementation(inner)
    wallet.listActions.mockResolvedValue({
      actions: [{ txid: orphanTxid, status: 'unsigned', reference: 'ref-orphan' }]
    })

    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.reclaimed).toBe(1)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-orphan' }, ADMIN)
    expect(wallet.createAction).toHaveBeenCalledTimes(2)
    validateReclaimSpends(f)
  })
})

// ── withdraw ──────────────────────────────────────────────────────────────

describe('withdrawFromVault', () => {
  it('lists with entire transactions + customInstructions, and creates a VERSION-2 action with the R1C unlock length, the BEEF, and undelayed strict options', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    await withdrawAll()

    const [listArgs] = wallet.listOutputs.mock.calls[0]
    expect(listArgs).toEqual({
      basket: VAULT_BASKET,
      include: 'entire transactions',
      includeCustomInstructions: true,
      limit: 1000
    })

    const [caArgs] = wallet.createAction.mock.calls[0]
    // Fixed regardless of the caller's `reason` (the ceremony's NFC prompt
    // text, 'Withdraw all' here) — the action's own description no longer
    // tracks it, so the amount never leaks into what shows in the activity
    // list for a withdrawal.
    expect(caArgs.description).toBe('Vault withdrawal')
    expect(caArgs.version).toBe(2) // spec §2.6: every vault spend is version 2
    expect(caArgs.inputs).toHaveLength(2)
    for (const i of caArgs.inputs) {
      expect(i).toEqual({ outpoint: i.outpoint, unlockingScriptLength: R1C_UNLOCK_LEN, inputDescription: 'Vault withdrawal' })
      expect(i.unlockingScriptLength).toBe(2560)
    }
    // Largest first.
    expect(caArgs.inputs.map((i: any) => i.outpoint)).toEqual([fx[0].outpoint, fx[1].outpoint])
    expect(caArgs.labels).toEqual(['vault', 'vault-withdraw'])
    expect(caArgs.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false, trustSelf: 'known' })
    // Sourced from the listOutputs result, not fabricated — and it decodes to
    // a BEEF containing every spent output's source transaction.
    const beef = Beef.fromBinary(caArgs.inputBEEF)
    for (const f of fx) expect(beef.findTxid(f.src.id('hex'))).toBeDefined()
  }, 60_000)

  it('produces unlocking scripts the strict interpreter accepts against the REAL version-2 signable transaction, keyed by input index', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    const r = await withdrawAll()
    expect(r.txid).toBe('feedface'.repeat(8))
    expect(lastSignable!.version).toBe(2)
    validateSpends(fx)
  }, 60_000)

  it('locates its inputs by outpoint when the toolbox prepends a funding input', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B])]
    await seedVault(fx, [KEY_A, KEY_B], { fundingFirst: true })
    await withdrawAll()
    const [saArgs] = wallet.signAction.mock.calls[0]
    expect(Object.keys(saArgs.spends).sort()).toEqual(['1', '2']) // input 0 is the toolbox's
    validateSpends(fx)
  }, 60_000)

  it('signs the digest of each input\'s REAL preimage, sequentially, with per-input progress, then reports broadcasting', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B]), vaultFixture(100_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw from vault', 'A-1')

    expect(requestVaultSigner).toHaveBeenCalledTimes(1)
    expect(requestVaultSigner).toHaveBeenCalledWith('Withdraw from vault', 'A-1')
    expect(signCalls).toHaveLength(3)
    signCalls.forEach((c, i) => {
      expect(c.progress).toEqual({ index: i, total: 3 })
      expect(c.digest).toBe(signerDigest(sighashPreimage(lastSignable!, i, fx[i].satoshis)))
    })
    const notes = (noteVaultProgress as jest.Mock).mock.calls.map(([p]) => p)
    expect(notes.slice(0, 3)).toEqual([
      { phase: 'preparing', signed: 0, total: 3 },
      { phase: 'preparing', signed: 1, total: 3 },
      { phase: 'preparing', signed: 2, total: 3 }
    ])
    expect(notes.at(-1)).toEqual({ phase: 'broadcasting' })
    expect(signerRelease).toHaveBeenCalledTimes(1)
  }, 90_000)

  it('hands the signed transaction to the monitor (acceptDelayedBroadcast: true) and stamps lastUsedSerial', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    await withdrawAll()
    const [saArgs] = wallet.signAction.mock.calls[0]
    expect(saArgs.reference).toBe('ref-1')
    expect(saArgs.options).toEqual({ acceptDelayedBroadcast: true })
    expect((await vaultStore.getMeta())!.lastUsedSerial).toBe('A-1')
  }, 60_000)

  it('a failing lastUsedSerial stamp never fails the transfer — the transaction is already with the monitor', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    jest.spyOn(vaultStore, 'noteLastUsed').mockRejectedValueOnce(new Error('disk full'))
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    await expect(withdrawAll()).resolves.toMatchObject({ txid: 'feedface'.repeat(8) })
    expect(wallet.signAction).toHaveBeenCalledTimes(1)
    expect(wallet.abortAction).not.toHaveBeenCalled() // past the point of no abort
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[vault] noteLastUsed failed'), 'disk full')
  }, 60_000)

  it('returns cappedInputs 0 and an empty unreachable set when every output is the chosen key\'s and fits', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    const r = await withdrawAll()
    expect(r).toEqual({ txid: 'feedface'.repeat(8), cappedInputs: 0, unreachable: { count: 0, satoshis: 0, keys: [] } })
  }, 60_000)

  // ── selection (spec §4.2 steps 2–3) ───────────────────────────────────

  it('filters to the chosen key BEFORE capping: 35 outputs, the 3 largest committed only to B, chosen A → the 32 A outputs, 3 unreachable', async () => {
    // A cap-before-filter bug would pick the three B-only outputs (they are
    // the largest) and either fail on the commitment check or leave A with
    // fewer than 32 inputs.
    const aOutputs = Array.from({ length: 32 }, (_, i) => vaultFixture(300_000 + i, [PUB_A, PUB_B]))
    const bOnly = Array.from({ length: 3 }, (_, i) => vaultFixture(900_000 + i, [PUB_B]))
    await seedVault([...bOnly, ...aOutputs])
    jest.spyOn(r1comb, 'verifyVaultInput').mockReturnValue(true) // 32 real verifications are for the device run

    const r = await withdrawAll()
    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.inputs).toHaveLength(VAULT_MAX_INPUTS)
    expect(caArgs.inputs.length).toBeLessThanOrEqual(VAULT_HARD_MAX_INPUTS)
    const aOutpoints = new Set(aOutputs.map(f => f.outpoint))
    for (const i of caArgs.inputs) expect(aOutpoints.has(i.outpoint)).toBe(true)
    expect(r.cappedInputs).toBe(0)
    expect(r.unreachable).toEqual({
      count: 3,
      satoshis: 900_000 + 900_001 + 900_002,
      keys: [{ serial: 'B-1', pubkey: PUB_B }]
    })
    expect(signCalls).toHaveLength(32)
  }, 120_000)

  it('caps at VAULT_MAX_INPUTS and reports the untouched outputs as cappedInputs', async () => {
    const fx = Array.from({ length: VAULT_MAX_INPUTS + 2 }, () => vaultFixture(300_000, [PUB_A, PUB_B]))
    await seedVault(fx)
    jest.spyOn(r1comb, 'verifyVaultInput').mockReturnValue(true)
    const r = await withdrawAll()
    expect(r.cappedInputs).toBe(2)
    expect(r.unreachable.count).toBe(0)
    expect(wallet.createAction.mock.calls[0][0].inputs).toHaveLength(VAULT_MAX_INPUTS)
  }, 120_000)

  it('choosing B selects only B\'s outputs and reports A\'s as unreachable, naming A', async () => {
    armWith(PRIV_B, PUB_B, 'B-1')
    const shared = vaultFixture(300_000, [PUB_A, PUB_B])
    const bOnly = vaultFixture(400_000, [PUB_B])
    const aOnly = vaultFixture(500_000, [PUB_A])
    await seedVault([shared, bOnly, aOnly])
    const r = await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw', 'B-1')
    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.inputs.map((i: any) => i.outpoint)).toEqual([bOnly.outpoint, shared.outpoint]) // largest first
    expect(r.unreachable).toEqual({ count: 1, satoshis: 500_000, keys: [{ serial: 'A-1', pubkey: PUB_A }] })
    validateSpends([shared, bOnly])
  }, 60_000)

  it('an unreachable output committed to a key no longer in meta is reported without a serial', async () => {
    const removed = Utils.toHex(Array.from(p256.getPublicKey(p256.utils.randomSecretKey(), true)))
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(700_000, [removed])])
    const r = await withdrawAll()
    expect(r.unreachable).toEqual({ count: 1, satoshis: 700_000, keys: [{ serial: undefined, pubkey: removed }] })
  }, 60_000)

  it('key-not-committed when the REAL lock lacks the chosen key\'s commitment although customInstructions claims it — before any reservation or tap', async () => {
    const liar = vaultFixture(300_000, [PUB_A, PUB_B], [PUB_B]) // record says A+B, lock says B
    await seedVault([liar])
    const err = await withdrawAll().catch(e => e)
    expect(err).toMatchObject({ code: 'key-not-committed' })
    expect(err.message).toContain(liar.outpoint)
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('key-not-committed when no output is committed to the chosen key at all', async () => {
    await seedVault([vaultFixture(300_000, [PUB_B]), vaultFixture(200_000, [PUB_B])])
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'key-not-committed' })
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('key-cannot-cover when the chosen key can open less than asked while other keys could open more', async () => {
    await seedVault([vaultFixture(500_000, [PUB_A, PUB_B]), vaultFixture(500_000, [PUB_B])])
    const err = await withdrawFromVault(wallet, ADMIN, 600_000, 'Withdraw', 'A-1').catch(e => e)
    expect(err).toMatchObject({ code: 'key-cannot-cover' })
    expect(err.message).toContain('500000')
    expect(err.message).toContain('1000000')
    expect(err.details).toEqual({ reachable: 500_000, total: 1_000_000 })
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('amount-exceeds-balance when the whole vault is too small', async () => {
    await seedVault([vaultFixture(250_000, [PUB_A, PUB_B])])
    await expect(withdrawFromVault(wallet, ADMIN, 300_000, 'Withdraw', 'A-1')).rejects.toMatchObject({
      code: 'amount-exceeds-balance'
    })
  })

  it('too-many-inputs when the amount cannot be funded within the cap although the key could open it', async () => {
    // 34 × 300,000 is plenty, but 32 inputs only reach 9,600,000 — an
    // input-count problem, not a balance or a key problem, and it must say so.
    await seedVault(Array.from({ length: VAULT_MAX_INPUTS + 2 }, () => vaultFixture(300_000, [PUB_A, PUB_B])))
    await expect(withdrawFromVault(wallet, ADMIN, 10_000_000, 'Withdraw', 'A-1')).rejects.toMatchObject({
      code: 'too-many-inputs'
    })
    expect(wallet.createAction).not.toHaveBeenCalled()
  }, 60_000)

  it('vault-empty when nothing decodes as v4 — a v3 K1 record is skipped, not spent', async () => {
    await seedMeta()
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        { outpoint: `${'aa'.repeat(32)}.0`, satoshis: 250_000, customInstructions: JSON.stringify({ v: 3, type: 'K1', keyID: 'bip32/0' }) },
        { outpoint: `${'bb'.repeat(32)}.0`, satoshis: 250_000, customInstructions: 'not json' }
      ]
    })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'vault-empty' })
  })

  it('not-enrolled for an unknown chosen serial, before listing anything', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw', 'Z-9')).rejects.toMatchObject({ code: 'not-enrolled' })
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('requires-online before anything else — an offline user is never asked for a key', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    await expect(withdrawAll({ isOnline: async () => false })).rejects.toMatchObject({ code: 'requires-online' })
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it.each([NaN, 0, -1, 1.5])(
    'below-dust for an amount that is not a positive integer (%p) — before the online probe, listing, reserving or tapping',
    async amount => {
      // Every amount check in selectVaultInputs is `amount > x`, which is
      // false for all four: unguarded, NaN would sweep everything the key can
      // open to the hot wallet, a negative would fund a re-vault output LARGER
      // than the inputs from the default basket, 0 would pay a fee to re-lock
      // everything, and 1.5 would ask for a fractional-satoshi output.
      await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
      const isOnline = jest.fn(async () => true)
      await expect(withdrawFromVault(wallet, ADMIN, amount, 'Withdraw', 'A-1', { isOnline })).rejects.toMatchObject({
        code: 'below-dust'
      })
      expect(isOnline).not.toHaveBeenCalled()
      expect(wallet.listOutputs).not.toHaveBeenCalled()
      expect(wallet.createAction).not.toHaveBeenCalled()
      expect(requestVaultSigner).not.toHaveBeenCalled()
    }
  )

  // ── remainder (spec §4.2 step 4) ───────────────────────────────────────

  it('re-vaults a remainder ≥ the floor as ONE output with a fresh salt committed to the CURRENT key set', async () => {
    const fx = [vaultFixture(500_000, [PUB_A, PUB_B]), vaultFixture(500_000, [PUB_A, PUB_B])]
    await seedVault(fx, [KEY_A, KEY_B, KEY_C]) // a key was added since these deposits
    await withdrawFromVault(wallet, ADMIN, 600_000, 'Withdraw', 'A-1')

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.outputs).toHaveLength(1)
    const out = caArgs.outputs[0]
    expect(out).toMatchObject({ satoshis: 400_000, basket: VAULT_BASKET, outputDescription: 'Vault change', tags: ['vault'] })
    expect(Utils.toArray(out.lockingScript, 'hex')).toHaveLength(R1C_LOCK_LEN(3))
    const ci = decodeVaultInstructions(out.customInstructions)!
    expect(ci.keys).toEqual([PUB_A, PUB_B, KEY_C.pubkey])
    expect(fx.map(f => f.salt)).not.toContain(ci.salt)
    expect(bakedCommitments(LockingScript.fromHex(out.lockingScript))).toEqual(
      [PUB_A, PUB_B, KEY_C.pubkey].map(pk => commitment(pk, ci.salt))
    )
    validateSpends(fx)
  }, 60_000)

  it('folds a sub-floor remainder into the withdrawal (no vault output)', async () => {
    await seedVault([vaultFixture(150_000, [PUB_A, PUB_B])])
    await withdrawFromVault(wallet, ADMIN, 100_000, 'Withdraw', 'A-1')
    // 50,000 is below VAULT_DEPOSIT_MIN: it reaches the user as toolbox
    // change rather than becoming an output not worth what it costs to move.
    expect(wallet.createAction.mock.calls[0][0].outputs).toEqual([])
  }, 60_000)

  it('refuses to CREATE a re-vault output while vaultEnabled is off (not-released); withdrawing all is never gated', async () => {
    await seedVault([vaultFixture(500_000, [PUB_A, PUB_B]), vaultFixture(500_000, [PUB_A, PUB_B])])
    await expect(
      withdrawFromVault(wallet, ADMIN, 600_000, 'Withdraw', 'A-1', { vaultEnabled: () => false })
    ).rejects.toMatchObject({ code: 'not-released' })
    expect(wallet.createAction).not.toHaveBeenCalled()

    await expect(withdrawAll({ vaultEnabled: () => false })).resolves.toMatchObject({ txid: expect.any(String) })
  }, 60_000)

  // ── the version invariant and D4b (spec §2.6, §4.2 step 5) ─────────────

  it('bad-version: a signable transaction that is not version 2 is aborted before any signature', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    const real = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementationOnce(async (args: any, o: string) => real({ ...args, version: 1 }, o))
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'bad-version' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it.each([
    ['a txid', { txid: 'cafe'.repeat(16) }],
    ['AtomicBEEF bytes', { tx: [1, 2, 3] }]
  ])(
    'fails closed when createAction returns a FINISHED transaction (%s) instead of a signable one: no-transaction, no tap, no signAction, lastUsed untouched',
    async (_shape, created) => {
      // Inputs carrying unlockingScriptLength always come back signable. A
      // finished transaction here would mean the toolbox spent R1C outputs
      // WITHOUT our unlocks — reporting its txid as success would be the worst
      // possible outcome, so the branch throws instead.
      await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
      const noteLastUsed = jest.spyOn(vaultStore, 'noteLastUsed')
      wallet.createAction.mockResolvedValueOnce(created)

      const err = await withdrawAll().catch(e => e)
      expect(err).toMatchObject({ code: 'no-transaction' })
      expect(err.message).toContain('refusing')
      expect(requestVaultSigner).not.toHaveBeenCalled()
      expect(wallet.signAction).not.toHaveBeenCalled()
      expect(noteLastUsed).not.toHaveBeenCalled()
      expect((await vaultStore.getMeta())!.lastUsedSerial).toBeUndefined()
    }
  )

  it('no-transaction when createAction returns neither a signable nor a finished transaction', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    wallet.createAction.mockResolvedValueOnce({})
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'no-transaction' })
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('a pushTxDerCheck hit aborts the reservation and re-creates the action with that input\'s sequenceNumber bumped', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    const check = jest.spyOn(r1comb, 'pushTxDerCheck').mockReturnValueOnce({ ok: false, s: 0n })

    const r = await withdrawAll()
    expect(r.txid).toBeDefined()
    expect(check).toHaveBeenCalledTimes(2) // once per attempt
    expect(wallet.createAction).toHaveBeenCalledTimes(2)
    const [first] = wallet.createAction.mock.calls[0]
    const [second] = wallet.createAction.mock.calls[1]
    expect(first.inputs[0]).not.toHaveProperty('sequenceNumber')
    expect(second.inputs[0].sequenceNumber).toBe(0xfffffffe)
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    // The signatures are over the SECOND transaction (sequence 0xfffffffe).
    expect(lastSignable!.inputs[0].sequence).toBe(0xfffffffe)
    validateSpends(fx)
  }, 60_000)

  it('gives up after 8 attempts with no-transaction, never tapping', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    jest.spyOn(r1comb, 'pushTxDerCheck').mockReturnValue({ ok: false, s: 0n })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'no-transaction' })
    expect(wallet.createAction).toHaveBeenCalledTimes(8)
    expect(wallet.abortAction).toHaveBeenCalledTimes(8)
    const seqs = wallet.createAction.mock.calls.map(([a]: [any]) => a.inputs[0].sequenceNumber)
    expect(seqs).toEqual([undefined, 0xfffffffe, 0xfffffffd, 0xfffffffc, 0xfffffffb, 0xfffffffa, 0xfffffff9, 0xfffffff8])
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
  }, 60_000)

  // ── abort discipline ───────────────────────────────────────────────────

  it('aborts the reservation and releases the signer when a signature fails (user cancel mid-batch)', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B])])
    ;(requestVaultSigner as jest.Mock).mockImplementationOnce(async () => ({
      serial: 'A-1',
      pubkey: PUB_A,
      sign: async () => {
        throw new VaultError('user-cancelled')
      },
      release: signerRelease
    }))
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    expect(signerRelease).toHaveBeenCalledTimes(1)
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('aborts the reservation when the tap itself fails (serial-mismatch from the ceremony)', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    ;(requestVaultSigner as jest.Mock).mockRejectedValueOnce(new VaultError('serial-mismatch', 'Tapped key B-1, chose key A-1'))
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'serial-mismatch' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('serial-mismatch when the signer\'s pubkey is not the chosen key\'s — released once, aborted, nothing signed', async () => {
    // The commitment check ran against chosen.pubkey; every unlock is built
    // with signer.pubkey. A ceremony that failed to enforce the serial (or a
    // slot whose key was regenerated under the same serial) must be caught
    // before the first digest reaches the card.
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    const sign = jest.fn()
    ;(requestVaultSigner as jest.Mock).mockImplementationOnce(async () => ({
      serial: 'B-1',
      pubkey: PUB_B,
      sign,
      release: signerRelease
    }))
    const err = await withdrawAll().catch(e => e)
    expect(err).toMatchObject({ code: 'serial-mismatch' })
    expect(err.details).toEqual({ tapped: 'B-1', chosen: 'A-1' })
    expect(signerRelease).toHaveBeenCalledTimes(1)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    expect(sign).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('aborts when local verification rejects an unlock — the signer is already released', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    jest.spyOn(r1comb, 'verifyVaultInput').mockImplementationOnce(() => {
      throw new Error('SCRIPT_ERR_EVAL_FALSE')
    })
    await expect(withdrawAll()).rejects.toThrow('SCRIPT_ERR_EVAL_FALSE')
    expect(signerRelease).toHaveBeenCalledTimes(1)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    expect(wallet.signAction).not.toHaveBeenCalled()
  }, 60_000)

  it('still aborts when the signable bytes do not parse (after createAction reserved, before anything exists to sign)', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    wallet.createAction.mockResolvedValueOnce({ signableTransaction: { tx: [0, 0, 0, 0], reference: 'ref-corrupt' } })
    await expect(withdrawAll()).rejects.toThrow()
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-corrupt' }, ADMIN)
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('does NOT abort when signAction itself fails — the transaction is signed and the network may have it', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    wallet.signAction.mockRejectedValueOnce(new Error('ETIMEDOUT posting to ARC'))
    await expect(withdrawAll()).rejects.toThrow('ETIMEDOUT')
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(signerRelease).toHaveBeenCalledTimes(1)
  }, 60_000)
})

// ── double-spend self-heal (unchanged behaviour, R1C fixtures) ────────────

describe('previewVaultWithdrawal', () => {
  it('reports the chosen key\'s selectable total, capped count and unreachable set — the same figures the withdrawal then uses — reserving and tapping nothing', async () => {
    const shared = vaultFixture(300_000, [PUB_A, PUB_B])
    const bOnly = vaultFixture(400_000, [PUB_B])
    const aOnly = vaultFixture(500_000, [PUB_A])
    await seedVault([shared, bOnly, aOnly])

    const preview = await previewVaultWithdrawal(wallet, ADMIN, 'A-1', 'all')
    expect(preview).toEqual({
      selectedTotal: 800_000, // A's two outputs, not the 1,200,000 balance
      cappedInputs: 0,
      unreachable: { count: 1, satoshis: 400_000, keys: [{ serial: 'B-1', pubkey: PUB_B }] }
    })
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(wallet.abortAction).not.toHaveBeenCalled()

    // The withdrawal that follows selects exactly what the preview said.
    const r = await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw', 'A-1')
    const [caArgs] = wallet.createAction.mock.calls[0]
    const selectedSum = (caArgs.inputs as { outpoint: string }[])
      .map(i => [shared, bOnly, aOnly].find(f => f.outpoint === i.outpoint)!.satoshis)
      .reduce((s, v) => s + v, 0)
    expect(selectedSum).toBe(preview.selectedTotal)
    expect(r.cappedInputs).toBe(preview.cappedInputs)
    expect(r.unreachable).toEqual(preview.unreachable)
  }, 60_000)

  it('the reviewer\'s case: vault 300,000 in three outputs, chosen key committed to 200,000, withdraw 150,000 → selectedTotal 200,000, and the withdrawal folds the 50,000 remainder', async () => {
    const fx = [vaultFixture(100_000, [PUB_A, PUB_B]), vaultFixture(100_000, [PUB_A, PUB_B]), vaultFixture(100_000, [PUB_B])]
    await seedVault(fx)
    const preview = await previewVaultWithdrawal(wallet, ADMIN, 'A-1', 150_000)
    expect(preview.selectedTotal).toBe(200_000) // NOT 300,000: the screen's remainder is 50,000, under the floor
    expect(preview.unreachable).toEqual({ count: 1, satoshis: 100_000, keys: [{ serial: 'B-1', pubkey: PUB_B }] })

    await withdrawFromVault(wallet, ADMIN, 150_000, 'Withdraw', 'A-1')
    // 200,000 − 150,000 = 50,000 < VAULT_DEPOSIT_MIN → folded: no vault output.
    expect(wallet.createAction.mock.calls[0][0].outputs).toEqual([])
  }, 60_000)

  it('reports cappedInputs like the withdrawal — selectedTotal is the capped sum', async () => {
    await seedVault(Array.from({ length: VAULT_MAX_INPUTS + 2 }, () => vaultFixture(300_000, [PUB_A, PUB_B])))
    const preview = await previewVaultWithdrawal(wallet, ADMIN, 'A-1', 'all')
    expect(preview.selectedTotal).toBe(VAULT_MAX_INPUTS * 300_000)
    expect(preview.cappedInputs).toBe(2)
    expect(preview.unreachable.count).toBe(0)
    expect(wallet.createAction).not.toHaveBeenCalled()
  }, 120_000)

  it('throws exactly the selection\'s refusals: key-cannot-cover with details, not-enrolled, and below-dust for a bad amount — before any reservation or tap', async () => {
    await seedVault([vaultFixture(500_000, [PUB_A, PUB_B]), vaultFixture(500_000, [PUB_B])])
    const err = await previewVaultWithdrawal(wallet, ADMIN, 'A-1', 600_000).catch(e => e)
    expect(err).toMatchObject({ code: 'key-cannot-cover' })
    expect(err.details).toEqual({ reachable: 500_000, total: 1_000_000 })

    await expect(previewVaultWithdrawal(wallet, ADMIN, 'Z-9', 'all')).rejects.toMatchObject({ code: 'not-enrolled' })
    await expect(previewVaultWithdrawal(wallet, ADMIN, 'A-1', NaN)).rejects.toMatchObject({ code: 'below-dust' })
    await expect(previewVaultWithdrawal(wallet, ADMIN, 'A-1', 0)).rejects.toMatchObject({ code: 'below-dust' })
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('does not probe the online signal — it is a database read', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    await expect(previewVaultWithdrawal(wallet, ADMIN, 'A-1', 'all')).resolves.toMatchObject({ selectedTotal: 300_000 })
  })
})

describe('withdraw self-heals a double-spend from stuck reservations', () => {
  const reviewError = (competingTxs: string[]) =>
    Object.assign(new Error('Undelayed createAction or signAction results require review.'), {
      code: 5,
      reviewActionResults: [{ txid: '', status: 'doubleSpend', competingTxs }]
    })

  /** One A+B output served, with the fake's createAction wrapped so the FIRST
   * call throws `err` and later calls run the real fabrication. */
  const oneOutputThrowingFirst = async (err: (outpoint: string) => unknown) => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    let createCalls = 0
    const real = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (...args: any[]) => {
      if (++createCalls === 1) throw err(fx[0].outpoint)
      return real(...(args as [unknown, string]))
    })
    return { fx, createCalls: () => createCalls }
  }

  test('aborts exactly the reserving txid (by txid match) then retries createAction', async () => {
    const RESERVING = 'ab'.repeat(32)
    const aborted: string[] = []
    const h = await oneOutputThrowingFirst(() => reviewError([RESERVING]))
    wallet.listActions.mockResolvedValue({
      actions: [
        { txid: RESERVING, status: 'nosend', reference: 'ref-reserving' }, // the culprit
        { txid: 'cd'.repeat(32), status: 'nosend', reference: 'ref-other' }, // unrelated txid
        { txid: RESERVING, status: 'completed', reference: 'ref-terminal' } // same txid, terminal
      ]
    })
    wallet.abortAction.mockImplementation(async (args: any) => {
      aborted.push(args.reference)
      return {}
    })

    const { txid } = await withdrawAll()
    expect(txid).toBeDefined()
    expect(h.createCalls()).toBe(2) // threw once, retried once
    expect(aborted).toEqual(['ref-reserving']) // only the matching txid + abortable status
  }, 60_000)

  // The shape a failed withdrawal ACTUALLY leaves behind: the orphan died
  // before signing, so it has no txid for the review path to blame and the
  // toolbox refuses the input with a plain WERR_INVALID_PARAMETER naming the
  // outpoint instead.
  const unspendableError = (outpoint: string) => {
    const [txid, vout] = outpoint.split('.')
    return Object.assign(
      new Error(
        `The inputs[0] parameter must be spendable output. output ${txid}:${vout} ` +
          'appears to have been spent (spendable=false).'
      ),
      { code: 'WERR_INVALID_PARAMETER' }
    )
  }

  test('aborts the orphan reserving the outpoint (matched on its inputs) then retries', async () => {
    const aborted: string[] = []
    const h = await oneOutputThrowingFirst(unspendableError)
    wallet.listActions.mockImplementation(async (args: any) => {
      expect(args.includeInputs).toBe(true) // cannot match on txid here, so it must ask for inputs
      if (args.offset > 0) return { actions: [] }
      return {
        actions: [
          { status: 'unsigned', reference: 'ref-orphan', inputs: [{ sourceOutpoint: h.fx[0].outpoint }] },
          { status: 'unsigned', reference: 'ref-other', inputs: [{ sourceOutpoint: `${'ee'.repeat(32)}.0` }] },
          { txid: 'cd'.repeat(32), status: 'completed', reference: 'ref-done', inputs: [{ sourceOutpoint: h.fx[0].outpoint }] }
        ]
      }
    })
    wallet.abortAction.mockImplementation(async (args: any) => {
      aborted.push(args.reference)
      return {}
    })

    const { txid } = await withdrawAll()
    expect(txid).toBeDefined()
    expect(h.createCalls()).toBe(2)
    expect(aborted).toEqual(['ref-orphan'])
  }, 60_000)

  test('with a storage lookup, heals from one query and never pages actions', async () => {
    const h = await oneOutputThrowingFirst(unspendableError)
    const asked: string[][] = []
    const findSpendingReferences = jest.fn(async (outpoints: string[]) => {
      asked.push(outpoints)
      return [
        { reference: 'ref-orphan', status: 'unsigned' },
        { reference: 'ref-done', status: 'completed' } // terminal → not abortable
      ]
    })

    const { txid } = await withdrawAll({ findSpendingReferences })
    expect(txid).toBeDefined()
    expect(h.createCalls()).toBe(2)
    expect(asked).toEqual([[h.fx[0].outpoint]])
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-orphan' }, ADMIN)
    expect(wallet.abortAction).not.toHaveBeenCalledWith({ reference: 'ref-done' }, ADMIN)
    expect(wallet.listActions).not.toHaveBeenCalled()
  }, 60_000)

  test('falls back to the scan when the storage lookup throws', async () => {
    const h = await oneOutputThrowingFirst(unspendableError)
    const findSpendingReferences = jest.fn(async () => {
      throw new Error('database is locked')
    })
    wallet.listActions.mockResolvedValue({
      actions: [{ status: 'unsigned', reference: 'ref-orphan', inputs: [{ sourceOutpoint: h.fx[0].outpoint }] }]
    })
    await expect(withdrawAll({ findSpendingReferences })).resolves.toMatchObject({ txid: expect.any(String) })
    expect(findSpendingReferences).toHaveBeenCalled()
    expect(wallet.listActions).toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-orphan' }, ADMIN)
  }, 60_000)

  test('matches the outpoint spelling the toolbox uses in error text (txid:vout)', async () => {
    const h = await oneOutputThrowingFirst(unspendableError)
    const [txid] = h.fx[0].outpoint.split('.')
    expect(h.fx[0].outpoint).toBe(`${txid}.0`)
    expect(unspendableError(h.fx[0].outpoint).message).toContain(`${txid}:0`)
    wallet.listActions.mockResolvedValue({
      actions: [{ status: 'nosend', reference: 'ref-orphan', inputs: [{ sourceOutpoint: h.fx[0].outpoint }] }]
    })
    await expect(withdrawAll()).resolves.toMatchObject({ txid: expect.any(String) })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-orphan' }, ADMIN)
  }, 60_000)

  test('rethrows an unrelated WERR_INVALID_PARAMETER without aborting anything', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    wallet.createAction.mockImplementation(async () => {
      throw Object.assign(new Error('The outputs[0].satoshis parameter must be a positive integer.'), {
        code: 'WERR_INVALID_PARAMETER'
      })
    })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'WERR_INVALID_PARAMETER' })
    expect(wallet.listActions).not.toHaveBeenCalled()
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(wallet.createAction).toHaveBeenCalledTimes(1) // no retry
  })

  test('rethrows when the wedged outpoint is not one this withdrawal is spending', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    wallet.createAction.mockImplementation(async () => {
      throw unspendableError(`${'ee'.repeat(32)}.0`)
    })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'WERR_INVALID_PARAMETER' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  test('rethrows when nothing reserving the outpoint can be aborted', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    wallet.listActions.mockResolvedValue({
      actions: [{ txid: 'cd'.repeat(32), status: 'completed', reference: 'ref-done', inputs: [{ sourceOutpoint: fx[0].outpoint }] }]
    })
    wallet.createAction.mockImplementation(async () => {
      throw unspendableError(fx[0].outpoint)
    })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'WERR_INVALID_PARAMETER' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  test('rethrows the review error when the reserving tx is not abortable/found', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    const RESERVING = 'ab'.repeat(32)
    wallet.listActions.mockResolvedValue({
      actions: [{ txid: RESERVING, status: 'completed', reference: 'ref-terminal' }]
    })
    wallet.createAction.mockImplementation(async () => {
      throw reviewError([RESERVING])
    })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 5 })
  })
})

// ── re-lock (spec §4.3) ───────────────────────────────────────────────────

describe('estimateRelockFee', () => {
  it('is ceil(size/1000)·satPerKb·1.1 over the declared unlock length and the new lock, computed without float drift', () => {
    // 1 input, 2-key lock: size = 10 + 1·(41+3+2560) + (3 + 27881 + 8) = 30,506 → 31 kB → 3,100 → +10 % = 3,410
    expect(estimateRelockFee(1, R1C_LOCK_LEN(2))).toBe(3410)
    // 32 inputs, 3-key lock: size = 10 + 32·2604 + (3 + 27906 + 8) = 111,255 → 112 kB → 11,200 → 12,320
    // (11200 * 1.1 is 12320.000000000002 in doubles — a float ceil would say 12,321.)
    expect(estimateRelockFee(32, R1C_LOCK_LEN(3))).toBe(12320)
    // satPerKb is a parameter: 31 kB · 50 = 1,550 → 1,705
    expect(estimateRelockFee(1, R1C_LOCK_LEN(2), 50)).toBe(1705)
    // Zero inputs is not a re-lock, but the arithmetic is still well-defined:
    // size = 27,902 → 28 kB → 2,800 → 3,080 (2800 * 1.1 is 3080.0000000000005 in doubles).
    expect(estimateRelockFee(0, R1C_LOCK_LEN(2))).toBe(3080)
  })
})

describe('relockVault', () => {
  const relock = (opts?: Parameters<typeof relockVault>[4]) => relockVault(wallet, ADMIN, 'Re-lock vault', 'A-1', opts)

  it('spends everything the chosen key can open into ONE fresh vault output of acc − fee committed to the CURRENT key set, with no withdrawal output', async () => {
    const fx = [vaultFixture(500_000, [PUB_A, PUB_B]), vaultFixture(500_000, [PUB_A, PUB_B])]
    await seedVault(fx, [KEY_A, KEY_B, KEY_C]) // a key was ADDED since these deposits
    const r = await relock()
    expect(r).toEqual({ txid: 'feedface'.repeat(8), cappedInputs: 0, unreachable: { count: 0, satoshis: 0, keys: [] } })

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.description).toBe('Re-lock vault')
    expect(caArgs.version).toBe(2)
    expect(caArgs.labels).toEqual(['vault', 'vault-relock'])
    expect(caArgs.inputs).toHaveLength(2)
    for (const i of caArgs.inputs) {
      expect(i.unlockingScriptLength).toBe(R1C_UNLOCK_LEN)
      expect(i.inputDescription).toBe('Vault re-lock')
    }
    expect(caArgs.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false, trustSelf: 'known' })

    // ONE output: the whole accumulated value minus the fee reserve, back into
    // the vault under the current three keys. No second output — the fake
    // cannot observe the default-basket surplus, but it can observe that no
    // withdrawal output was asked for.
    expect(caArgs.outputs).toHaveLength(1)
    const out = caArgs.outputs[0]
    const fee = estimateRelockFee(2, R1C_LOCK_LEN(3))
    expect(out).toMatchObject({ satoshis: 1_000_000 - fee, basket: VAULT_BASKET, outputDescription: 'Vault re-lock', tags: ['vault'] })
    expect(Utils.toArray(out.lockingScript, 'hex')).toHaveLength(R1C_LOCK_LEN(3))
    const ci = decodeVaultInstructions(out.customInstructions)!
    expect(ci.keys).toEqual([PUB_A, PUB_B, KEY_C.pubkey])
    expect(fx.map(f => f.salt)).not.toContain(ci.salt) // fresh salt
    expect(bakedCommitments(LockingScript.fromHex(out.lockingScript))).toEqual(
      [PUB_A, PUB_B, KEY_C.pubkey].map(pk => commitment(pk, ci.salt))
    )
    validateSpends(fx)
    expect((await vaultStore.getMeta())!.lastUsedSerial).toBe('A-1')
  }, 60_000)

  it('after a key was REMOVED, the re-lock output is committed only to the remaining keys', async () => {
    const fx = [vaultFixture(500_000, [PUB_A, PUB_B, KEY_C.pubkey])]
    await seedVault(fx, [KEY_A, KEY_B]) // C removed
    await relock()
    const out = wallet.createAction.mock.calls[0][0].outputs[0]
    expect(decodeVaultInstructions(out.customInstructions)!.keys).toEqual([PUB_A, PUB_B])
    expect(Utils.toArray(out.lockingScript, 'hex')).toHaveLength(R1C_LOCK_LEN(2))
    expect(out.satoshis).toBe(500_000 - estimateRelockFee(1, R1C_LOCK_LEN(2)))
    validateSpends(fx)
  }, 60_000)

  it('too-small-to-relock when acc − fee would fall below the floor — nothing reserved, no tap; exactly the floor passes', async () => {
    await seedVault([vaultFixture(100_000, [PUB_A, PUB_B])]) // 100,000 − 3,410 < 100,000
    const err = await relock().catch(e => e)
    expect(err).toMatchObject({ code: 'too-small-to-relock' })
    expect(err.message).toContain('96590')
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()

    await seedVault([vaultFixture(100_000 + estimateRelockFee(1, R1C_LOCK_LEN(2)), [PUB_A, PUB_B])])
    await expect(relock()).resolves.toMatchObject({ txid: expect.any(String) })
    expect(wallet.createAction.mock.calls[0][0].outputs[0].satoshis).toBe(VAULT_DEPOSIT_MIN)
  }, 60_000)

  it('not-released when the flag is off — before listing or tapping; reads isVaultEnabled() when opts omit it', async () => {
    await seedVault([vaultFixture(500_000, [PUB_A, PUB_B])])
    await expect(relock({ vaultEnabled: () => false })).rejects.toMatchObject({ code: 'not-released' })
    ;(isVaultEnabled as jest.Mock).mockReturnValueOnce(false)
    await expect(relock()).rejects.toMatchObject({ code: 'not-released' })
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('requires-online before listing', async () => {
    await seedVault([vaultFixture(500_000, [PUB_A, PUB_B])])
    await expect(relock({ isOnline: async () => false })).rejects.toMatchObject({ code: 'requires-online' })
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('selects like a withdrawal: outputs the chosen key cannot open are reported as unreachable, so the screen can ask for another key', async () => {
    const mine = vaultFixture(500_000, [PUB_A, PUB_B])
    const theirs = vaultFixture(400_000, [PUB_B])
    await seedVault([mine, theirs])
    const r = await relock()
    expect(r.unreachable).toEqual({ count: 1, satoshis: 400_000, keys: [{ serial: 'B-1', pubkey: PUB_B }] })
    expect(wallet.createAction.mock.calls[0][0].inputs.map((i: any) => i.outpoint)).toEqual([mine.outpoint])
    expect(wallet.createAction.mock.calls[0][0].outputs[0].satoshis).toBe(500_000 - estimateRelockFee(1, R1C_LOCK_LEN(2)))
    validateSpends([mine])
  }, 60_000)

  it('caps like a withdrawal and reports cappedInputs so the screen can run another pass', async () => {
    await seedVault(Array.from({ length: VAULT_MAX_INPUTS + 1 }, () => vaultFixture(300_000, [PUB_A, PUB_B])))
    jest.spyOn(r1comb, 'verifyVaultInput').mockReturnValue(true)
    const r = await relock()
    expect(r.cappedInputs).toBe(1)
    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.inputs).toHaveLength(VAULT_MAX_INPUTS)
    expect(caArgs.outputs[0].satoshis).toBe(VAULT_MAX_INPUTS * 300_000 - estimateRelockFee(VAULT_MAX_INPUTS, R1C_LOCK_LEN(2)))
  }, 120_000)
})

// ── coverage (spec §3.4 badges) ───────────────────────────────────────────

describe('getVaultKeyCoverage', () => {
  let n = 0
  const rec = (keys: string[]) => ({
    outpoint: `${'ab'.repeat(32)}.${n++}`,
    satoshis: 1,
    customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt: 'cd'.repeat(32), keys })
  })
  const removed = Utils.toHex(Array.from(p256.getPublicKey(p256.utils.randomSecretKey(), true)))

  it('counts stale outputs in both directions, names the missing current keys, and counts outputs still open to a removed key', async () => {
    await seedMeta([KEY_A, KEY_B])
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        rec([PUB_A, PUB_B]), // current
        rec([PUB_A]), // stale: B was added after this deposit → "not yet open to Safe"
        rec([PUB_A, PUB_B, removed]), // stale: a removed key can still open it
        { outpoint: `${'ee'.repeat(32)}.0`, satoshis: 5, customInstructions: JSON.stringify({ v: 3, type: 'K1', keyID: 'bip32/0' }) }, // ignored
        { outpoint: `${'ff'.repeat(32)}.0`, satoshis: 5, customInstructions: '{' } // ignored
      ]
    })
    expect(await getVaultKeyCoverage(wallet, ADMIN)).toEqual({
      outputs: 3,
      stale: 2,
      missingKeys: [PUB_B],
      removedKeyOutputs: 1
    })
    const [listArgs] = wallet.listOutputs.mock.calls[0]
    expect(listArgs).toMatchObject({ basket: VAULT_BASKET, includeCustomInstructions: true, limit: 1000 })
  })

  it('is all-zero for an empty vault and for a vault whose every output matches the current set', async () => {
    await seedMeta([KEY_A, KEY_B])
    wallet.listOutputs.mockResolvedValueOnce({ outputs: [] })
    expect(await getVaultKeyCoverage(wallet, ADMIN)).toEqual({ outputs: 0, stale: 0, missingKeys: [], removedKeyOutputs: 0 })

    wallet.listOutputs.mockResolvedValueOnce({ outputs: [rec([PUB_A, PUB_B]), rec([PUB_B, PUB_A])] }) // order is irrelevant
    expect(await getVaultKeyCoverage(wallet, ADMIN)).toEqual({ outputs: 2, stale: 0, missingKeys: [], removedKeyOutputs: 0 })
  })

  it('with no key list every output is stale and open to a removed key, and nothing is missing', async () => {
    wallet.listOutputs.mockResolvedValueOnce({ outputs: [rec([PUB_A, PUB_B]), rec([PUB_A])] })
    expect(await getVaultKeyCoverage(wallet, ADMIN)).toEqual({ outputs: 2, stale: 2, missingKeys: [], removedKeyOutputs: 2 })
  })

  it('missingKeys follows meta order and lists each key once however many outputs lack it', async () => {
    await seedMeta([KEY_A, KEY_B, KEY_C])
    wallet.listOutputs.mockResolvedValueOnce({ outputs: [rec([PUB_A]), rec([PUB_A]), rec([PUB_B])] })
    expect(await getVaultKeyCoverage(wallet, ADMIN)).toEqual({ outputs: 3, stale: 3, missingKeys: [PUB_A, PUB_B, KEY_C.pubkey], removedKeyOutputs: 0 })
  })
})

describe('orphanedIfRemoved', () => {
  it('counts vault outputs that would lose every remaining key if the given pubkey were removed', async () => {
    await seedMeta([KEY_A, KEY_B])
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        { outpoint: `${'ab'.repeat(32)}.0`, satoshis: 1, customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt: 'cd'.repeat(32), keys: [PUB_A, PUB_B] }) },
        { outpoint: `${'ab'.repeat(32)}.1`, satoshis: 1, customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt: 'ce'.repeat(32), keys: [PUB_A] }) }
      ]
    })
    expect(await orphanedIfRemoved(wallet, ADMIN, PUB_A)).toBe(1)

    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        { outpoint: `${'ab'.repeat(32)}.0`, satoshis: 1, customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt: 'cd'.repeat(32), keys: [PUB_A, PUB_B] }) },
        { outpoint: `${'ab'.repeat(32)}.1`, satoshis: 1, customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt: 'ce'.repeat(32), keys: [PUB_A] }) }
      ]
    })
    expect(await orphanedIfRemoved(wallet, ADMIN, PUB_B)).toBe(0)
  })
})

// ── balance ───────────────────────────────────────────────────────────────

describe('getVaultBalance', () => {
  it('sums decodable v4 outputs only — a v3 K1 record, a malformed one and a missing one are ignored', async () => {
    const v4 = (sats: number) => ({
      outpoint: `${'ab'.repeat(32)}.${sats}`,
      satoshis: sats,
      customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt: 'cd'.repeat(32), keys: [PUB_A, PUB_B] })
    })
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        v4(3000),
        v4(4500),
        { outpoint: 'v3.0', satoshis: 1000, customInstructions: JSON.stringify({ v: 3, type: 'K1', keyID: 'bip32/0' }) },
        { outpoint: 'bad.0', satoshis: 2000, customInstructions: 'not json' },
        { outpoint: 'none.0', satoshis: 700 }
      ]
    })
    expect(await getVaultBalance(wallet, ADMIN)).toBe(7500)
    // Without this flag listOutputs omits customInstructions and EVERYTHING
    // would read as undecodable — a zero balance over a full vault.
    const [listArgs] = wallet.listOutputs.mock.calls[0]
    expect(listArgs).toEqual({ basket: VAULT_BASKET, includeCustomInstructions: true, limit: 1000 })
  })

  it('is zero for an empty basket', async () => {
    expect(await getVaultBalance(wallet, ADMIN)).toBe(0)
  })
})
