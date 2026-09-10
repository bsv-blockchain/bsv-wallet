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
  bakedCommitments,
  commitment,
  decodeVaultInstructions
} from '../../core/services/vault/r1comb'

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
import {
  VAULT_BASKET,
  VAULT_DEPOSIT_MIN,
  VAULT_STAGING_BASKET,
  VaultWallet,
  depositToVault,
  reclaimStagingOutputs
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
})

// Spies on r1comb (Task 10 stubs verifyVaultInput / pushTxDerCheck in a few
// tests) must not leak between tests: a stubbed verifyVaultInput would let a
// later "the interpreter accepts it" test pass vacuously. Everything the
// beforeEach above creates or re-arms survives this.
afterEach(() => jest.restoreAllMocks())

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
    expect(args.description).toBe('Move to vault')
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
