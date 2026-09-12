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
import { Beef, Hash, KeyDeriver, LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { specOpFailedActions } from '@bsv/wallet-toolbox-mobile/out/src/sdk/types'
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
  vaultSaltHmacData,
  type VaultSaltChain,
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
  ...(() => {
    const store: Record<string, string> = {}
    return {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wutdo',
      getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
      setItemAsync: jest.fn(async (k: string, v: string) => { store[k] = v }),
      deleteItemAsync: jest.fn(async (k: string) => { delete store[k] }),
      __clear: () => { for (const k of Object.keys(store)) delete store[k] }
    }
  })()
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
  getBackupUrl: jest.fn(() => 'https://backup.example'),
  isVaultEnabled: jest.fn(() => true)
}))
jest.mock('../../core/backup/preference', () => ({
  isBackupPushEnabled: jest.fn(async () => true)
}))
import AsyncStorage from '@react-native-async-storage/async-storage'
import { isBackupPushEnabled } from '../../core/backup/preference'
import { getBackupUrl, isVaultEnabled } from '../../core/toolboxConfig'
import { noteVaultProgress, requestVaultSigner } from '../../core/services/vault/ceremonyHost'
import { vaultStore, VaultKeyRecord } from '../../core/services/vault/vaultStore'
import type { VaultSigner } from '../../core/services/vault/ceremony'
import { VaultError } from '../../core/services/vault/types'
import {
  VAULT_BASKET,
  VAULT_DEPOSIT_MIN,
  VAULT_HARD_MAX_INPUTS,
  VAULT_MAX_INPUTS,
  VAULT_SALT_PROTOCOL,
  VaultWallet,
  beginVaultKeyRemoval,
  depositToVault,
  disableVaultWhenSafe,
  estimateRelockFee,
  finalizeVaultKeyRemoval,
  getVaultBalance,
  getVaultKeyCoverage,
  orphanedIfRemoved,
  previewVaultWithdrawal,
  recoverVaultMetaFromOutputs,
  relockVault,
  withdrawFromVault
} from '../../core/services/vault/transfers'

const ADMIN = 'admin.com'
const VAULT_ID = '11'.repeat(32)
const SCOPE_IDENTITY = `02${'22'.repeat(32)}`
const SALT_DERIVER = new KeyDeriver(new PrivateKey(42))
let fixtureSaltIndex = 1000

function fixtureSalt(index = fixtureSaltIndex++, serials: readonly string[] = ['A-1', 'B-1']): {
  salt: string
  saltKeyId: string
} {
  const saltKeyId = String(index)
  const key = SALT_DERIVER.deriveSymmetricKey([...VAULT_SALT_PROTOCOL], saltKeyId, 'self')
  return {
    salt: Utils.toHex(Hash.sha256hmac(key.toArray(), vaultSaltHmacData(serials))),
    saltKeyId
  }
}

// Two software P-256 keys standing in for two enrolled YubiKeys, generated
// once for the whole file. Their compressed pubkeys are what output metadata records;
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
  await vaultStore.setMeta({ v: 6, vaultId: VAULT_ID, revision: 2, createdAt: 1, keys })
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
  createHmac: jest.Mock
  createAction: jest.Mock
  signAction: jest.Mock
  listOutputs: jest.Mock
  abortAction: jest.Mock
  listActions: jest.Mock
}

beforeEach(async () => {
  fixtureSaltIndex = 1000
  await AsyncStorage.clear()
  ;(jest.requireMock('expo-secure-store') as { __clear: () => void }).__clear()
  vaultStore.clearScope()
  vaultStore.configureScope({ identityKey: SCOPE_IDENTITY, chain: 'test' })
  wallet = {
    createHmac: jest.fn(async (args: any) => ({
      hmac: Hash.sha256hmac(
        SALT_DERIVER.deriveSymmetricKey(args.protocolID, args.keyID, args.counterparty).toArray(),
        args.data
      )
    })),
    createAction: jest.fn(async (args: any) => {
      if (args?.options?.sendWith) {
        return { sendWithResults: [{ txid: args.options.sendWith[0], status: 'sending' }] }
      }
      if (args?.labels?.includes('vault-deposit')) {
        const requested = args.outputs[0]
        const fund = new Transaction()
        fund.addOutput({
          satoshis: requested.satoshis + 10_000,
          lockingScript: new P2PKH().lock(Utils.toArray('55'.repeat(20), 'hex'))
        })
        const tx = new Transaction(args.version ?? 1)
        tx.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
        tx.addOutput({ satoshis: requested.satoshis, lockingScript: LockingScript.fromHex(requested.lockingScript) })
        tx.addOutput({ satoshis: 9_500, lockingScript: new P2PKH().lock(Utils.toArray('66'.repeat(20), 'hex')) })
        lastSignable = tx
        return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'deposit-ref' } }
      }
      return { txid: 'deadbeef'.repeat(8) }
    }),
    signAction: jest.fn(async (args: any) => {
      if (args?.options?.noSend && lastSignable) {
        for (const [index, spend] of Object.entries(args.spends ?? {}) as [string, { unlockingScript: string }][]) {
          lastSignable.inputs[Number(index)].unlockingScript = UnlockingScript.fromHex(spend.unlockingScript)
        }
        const txid = lastSignable.id('hex')
        return {
          txid,
          tx: lastSignable.toAtomicBEEF()
        }
      }
      return { txid: 'feedface'.repeat(8) }
    }),
    listOutputs: jest.fn(async () => ({ outputs: [] })),
    abortAction: jest.fn(async () => ({})),
    listActions: jest.fn(async () => ({ actions: [] }))
  }
  ;(isVaultEnabled as jest.Mock).mockReturnValue(true)
  ;(getBackupUrl as jest.Mock).mockReturnValue('https://backup.example')
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
 * A real R1C vault output: fresh salt, lock committed to `lockKeys`, and a v6
 * record claiming `keys`. The two agree unless a test says otherwise (the
 * key-not-committed case bakes a lock the record lies about).
 */
function vaultFixture(
  satoshis: number,
  keys: string[],
  lockKeys: string[] = keys,
  chain: VaultSaltChain = 'test'
): VaultFixture {
  const instructionKeys = keys.map((pubkey, i) => {
    const known = [KEY_A, KEY_B, KEY_C].find(key => key.pubkey === pubkey)
    return known ?? { serial: `fixture-${i}-${pubkey.slice(-6)}`, slot: 0x82, pubkey, nickname: `Fixture ${i + 1}`, enrolledAt: i + 10 }
  })
  const { salt, saltKeyId } = fixtureSalt(undefined, instructionKeys.map(key => key.serial))
  const lockingScript = buildLock({ commitments: lockKeys.map(pk => commitment(pk, salt)), saltHex64: salt })
  const src = new Transaction()
  src.addOutput({ satoshis, lockingScript })
  return {
    outpoint: `${src.id('hex')}.0`,
    satoshis,
    salt,
    keys,
    lockingScript,
    src,
    customInstructions: encodeVaultInstructions({
      v: 6,
      type: 'R1C',
      salt,
      saltKeyId,
      chain,
      vaultId: VAULT_ID,
      revision: 1,
      createdAt: 1,
      keys: instructionKeys
    })
  }
}

function fixtureFromVaultOutput(output: { satoshis: number; lockingScript: string; customInstructions: string }): VaultFixture {
  const ci = decodeVaultInstructions(output.customInstructions)!
  const lockingScript = LockingScript.fromHex(output.lockingScript)
  const src = new Transaction()
  src.addOutput({ satoshis: output.satoshis, lockingScript })
  return {
    outpoint: `${src.id('hex')}.0`,
    satoshis: output.satoshis,
    salt: ci.salt,
    keys: ci.keys.map(key => key.pubkey),
    lockingScript,
    src,
    customInstructions: output.customInstructions
  }
}

function serveVaultOutputs(fixtures: VaultFixture[]): void {
  wallet.listOutputs.mockImplementation(async (args: any) =>
    args?.basket === VAULT_BASKET
      ? {
          outputs: fixtures.map(f => ({ outpoint: f.outpoint, satoshis: f.satoshis, customInstructions: f.customInstructions })),
          BEEF: stitchBeef(fixtures)
        }
      : { outputs: [] }
  )
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
      : { outputs: [] }
  )
  wallet.createAction.mockImplementation(async (args: any) => {
    if (args?.options?.sendWith) {
      return { sendWithResults: [{ txid: args.options.sendWith[0], status: 'sending' }] }
    }
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
    // The toolbox's one implicit default-basket change, leaving a realistic
    // 500-satoshi fee for the exact proposed transaction.
    const inputValue = tx.inputs.reduce((sum, input) => sum + (input.sourceTransaction?.outputs[input.sourceOutputIndex].satoshis ?? 0), 0)
    const explicitValue = tx.outputs.reduce((sum, output) => sum + (output.satoshis ?? 0), 0)
    const change = inputValue - explicitValue - 500
    if (change > 0) {
      tx.addOutput({ satoshis: change, lockingScript: new P2PKH().lock(Utils.toArray('11'.repeat(20), 'hex')) })
    }
    lastSignable = tx
    return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-1' } }
  })
}

/** Mutate the next wallet-core proposal before transfers.ts sees it. */
function tamperNextSignable(mutator: (tx: Transaction) => void): void {
  const real = wallet.createAction.getMockImplementation()!
  wallet.createAction.mockImplementationOnce(async (...args: any[]) => {
    const created = await real(...(args as [unknown, string]))
    const tx = Transaction.fromAtomicBEEF(created.signableTransaction!.tx)
    mutator(tx)
    lastSignable = tx
    return {
      ...created,
      signableTransaction: { ...created.signableTransaction!, tx: tx.toAtomicBEEF() }
    }
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
 * flags against the fake's real version-1 transaction. */
const validateSpends = (fx: VaultFixture[]): void => {
  const [caArgs] = [...wallet.createAction.mock.calls].reverse().find(([args]) => Array.isArray(args.inputs))!
  const [saArgs] = wallet.signAction.mock.calls.find(([args]) => Object.keys(args.spends ?? {}).length > 0)!
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

  const heldDepositAction = (
    status: 'unsigned' | 'nosend' = 'nosend',
    chain: VaultSaltChain = 'test'
  ) => {
    const { salt, saltKeyId } = fixtureSalt(900)
    const lockingScript = buildLock({
      commitments: [KEY_A, KEY_B].map(key => commitment(key.pubkey, salt)),
      saltHex64: salt
    }).toHex()
    return {
      ...(status === 'nosend' ? { txid: 'd5'.repeat(32) } : {}),
      reference: 'held-deposit-ref',
      status,
      labels: ['vault', 'vault-deposit'],
      inputs: [{
        sourceOutpoint: `${'d6'.repeat(32)}.0`,
        sourceSatoshis: 260_000,
        sourceLockingScript: new P2PKH().lock(Utils.toArray('d7'.repeat(20), 'hex')).toHex()
      }],
      outputs: [{
        satoshis: 250_000,
        spendable: true,
        customInstructions: encodeVaultInstructions({
          v: 6,
          type: 'R1C',
          salt,
          saltKeyId,
          chain,
          vaultId: VAULT_ID,
          revision: 2,
          createdAt: 1,
          keys: [KEY_A, KEY_B]
        }),
        lockingScript,
        outputIndex: 0,
        basket: VAULT_BASKET
      }, {
        satoshis: 9_500,
        spendable: true,
        lockingScript: new P2PKH().lock(Utils.toArray('d8'.repeat(20), 'hex')).toHex(),
        outputIndex: 1,
        basket: 'default'
      }]
    }
  }

  it('builds and inspects one version-1 noSend transaction before releasing it, without hardware or a backup receipt', async () => {
    await seedMeta()
    const { txid } = await depositToVault(wallet, ADMIN, 250_000)
    expect(txid).toBe(lastSignable!.id('hex'))

    // One action builds the noSend; the second sendWith call broadcasts the
    // same inspected transaction and creates no additional output.
    expect(wallet.createAction).toHaveBeenCalledTimes(2)
    const args = depositArgs()
    expect(args.version).toBe(1)
    expect(args.inputs).toBeUndefined() // funding is the toolbox's own coin selection
    expect(args.inputBEEF).toBeUndefined()
    expect(args.description).toBe('Vault deposit')
    // The label is load-bearing: the patched toolbox suppresses UTXO-pool
    // growth for 'vault-deposit', keeping the deposit shape minimal.
    expect(args.labels).toEqual(['vault', 'vault-deposit'])
    expect(args.options).toEqual({ randomizeOutputs: false, noSend: true, signAndProcess: false })
    expect(args.outputs).toHaveLength(1)
    expect(args.outputs[0]).toMatchObject({
      satoshis: 250_000,
      basket: VAULT_BASKET,
      outputDescription: 'Vault deposit',
      tags: ['vault']
    })

    expect(wallet.signAction).toHaveBeenCalledWith(
      { reference: 'deposit-ref', spends: {}, options: { noSend: true } },
      ADMIN
    )
    expect(wallet.createAction.mock.calls[1][0]).toEqual({
      description: 'Broadcast Vault deposit',
      options: { sendWith: [txid] }
    })
    // No hardware ceremony or custom-input signing.
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(noteVaultProgress).not.toHaveBeenCalled()
    expect(wallet.listOutputs).toHaveBeenCalled() // authoritative collision scan
  })

  it('never aborts or duplicates a crash-discovered signed noSend deposit', async () => {
    await seedMeta()
    let held = true
    wallet.listActions.mockImplementation(async (args: any) => ({
      actions: args.labels?.includes(specOpFailedActions) || !held ? [] : [heldDepositAction('nosend')]
    }))
    wallet.abortAction.mockImplementation(async ({ reference }: any) => {
      expect(reference).toBe('held-deposit-ref')
      held = false
      return {}
    })

    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'relock-required' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('rejects a wallet action response larger than the requested page before retaining its rows', async () => {
    await seedMeta()
    wallet.listActions.mockResolvedValue({
      actions: Array.from({ length: 201 }, (_, index) => ({
        reference: `oversized-${index}`,
        status: 'completed'
      }))
    })

    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'no-transaction' })
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('pages detailed action history in small batches without imposing a total-history cap', async () => {
    await seedMeta()
    const history = Array.from({ length: 9 }, (_, index) => ({
      reference: `ordinary-${index}`,
      status: 'completed',
      labels: []
    }))
    wallet.listActions.mockImplementation(async (args: any) => {
      if (args.labels?.includes(specOpFailedActions)) return { actions: [], totalActions: 0 }
      return {
        actions: history.slice(args.offset, args.offset + args.limit),
        totalActions: history.length
      }
    })

    await expect(depositToVault(wallet, ADMIN, 250_000)).resolves.toMatchObject({ txid: expect.any(String) })
    const detailed = wallet.listActions.mock.calls
      .map(([args]) => args)
      .filter(args => args.includeInputSourceLockingScripts || args.includeOutputLockingScripts)
    expect(detailed.length).toBeGreaterThan(0)
    expect(detailed.every(args => args.limit === 8)).toBe(true)
    expect(detailed.some(args => args.offset === 8)).toBe(true)
  })

  it('recovers an unsigned deposit and indexes its real failed-history shape by reference when txid is empty', async () => {
    await seedMeta()
    const unsigned = heldDepositAction('unsigned')
    const failed = { ...unsigned, txid: '', status: 'failed' }
    let aborted = false
    wallet.listActions.mockImplementation(async (args: any) => ({
      actions: !aborted
        ? [unsigned]
        : args.labels?.includes(specOpFailedActions)
          ? [failed]
          : []
    }))
    wallet.abortAction.mockImplementation(async ({ reference }: any) => {
      expect(reference).toBe('held-deposit-ref')
      aborted = true
      return {}
    })

    await expect(depositToVault(wallet, ADMIN, 250_000)).resolves.toMatchObject({ txid: expect.any(String) })
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
    expect(wallet.createAction).toHaveBeenCalledTimes(2)
  })

  it('fails closed instead of aborting a held deposit whose authenticated plan is malformed', async () => {
    await seedMeta()
    const malformed = heldDepositAction('nosend')
    malformed.outputs[0].lockingScript = new P2PKH().lock(Utils.toArray('d9'.repeat(20), 'hex')).toHex()
    wallet.listActions.mockResolvedValue({ actions: [malformed] })

    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'relock-required' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('fails closed without aborting an unsigned held deposit from another network', async () => {
    await seedMeta()
    wallet.listActions.mockResolvedValue({ actions: [heldDepositAction('unsigned', 'main')] })

    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'relock-required' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('fails closed without aborting an unsigned held deposit whose salt belongs to another wallet', async () => {
    await seedMeta()
    wallet.listActions.mockResolvedValue({ actions: [heldDepositAction('unsigned')] })
    const foreignDeriver = new KeyDeriver(new PrivateKey(43))
    wallet.createHmac.mockImplementation(async (args: any) => ({
      hmac: Hash.sha256hmac(
        foreignDeriver.deriveSymmetricKey(args.protocolID, args.keyID, args.counterparty).toArray(),
        args.data
      )
    }))

    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({
      code: 'template-invalid',
      message: expect.stringContaining('does not belong to this wallet')
    })
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('does not abort a held deposit if wallet scope changes during its salt check', async () => {
    await seedMeta()
    wallet.listActions.mockResolvedValue({ actions: [heldDepositAction('unsigned')] })
    wallet.createHmac.mockImplementation(async (args: any) => {
      const hmac = Hash.sha256hmac(
        SALT_DERIVER.deriveSymmetricKey(args.protocolID, args.keyID, args.counterparty).toArray(),
        args.data
      )
      vaultStore.configureScope({ identityKey: `03${'44'.repeat(32)}`, chain: 'main' })
      return { hmac }
    })

    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'scope-changed' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('refuses to disable over an exact signed noSend deposit and never frees its inputs', async () => {
    await seedMeta()
    let held = true
    wallet.listActions.mockImplementation(async (args: any) => ({
      actions: args.labels?.includes(specOpFailedActions) || !held ? [] : [heldDepositAction('nosend')]
    }))
    wallet.abortAction.mockImplementation(async () => {
      held = false
      return {}
    })
    const clear = jest.fn(async (_token?: unknown) => {})

    await expect(disableVaultWhenSafe(wallet, ADMIN, clear)).rejects.toMatchObject({ code: 'relock-required' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('rejects foreign-network Vault history before clearing enrollment metadata', async () => {
    await seedMeta()
    const foreign = { ...heldDepositAction('nosend', 'main'), status: 'completed' }
    wallet.listActions.mockImplementation(async (args: any) => ({
      actions: args.labels?.includes(specOpFailedActions) ? [] : [foreign]
    }))
    const clear = jest.fn(async (_token?: unknown) => {})

    await expect(disableVaultWhenSafe(wallet, ADMIN, clear)).rejects.toMatchObject({
      code: 'template-invalid',
      message: 'Vault action history output belongs to a different network'
    })
    expect(clear).not.toHaveBeenCalled()
  })

  it('bakes a wallet-derived HMAC salt and every enrolled key into a v6 recovery record', async () => {
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000)
    const out = depositArgs().outputs[0]

    // The R1C lock for two keys, byte-exact in length.
    expect(Utils.toArray(out.lockingScript, 'hex')).toHaveLength(R1C_LOCK_LEN(2))

    const ci = decodeVaultInstructions(out.customInstructions)!
    expect(ci).not.toBeNull()
    expect(ci.v).toBe(6)
    expect(ci.type).toBe('R1C')
    expect(ci.salt).toMatch(/^[0-9a-f]{64}$/)
    expect(ci.salt).toBe(fixtureSalt(1, ['A-1', 'B-1']).salt)
    expect(ci.chain).toBe('test')
    expect(ci.saltKeyId).toBe('1')
    expect(wallet.createHmac).toHaveBeenCalledWith({
      protocolID: [2, 'vault salt'],
      keyID: ci.saltKeyId,
      counterparty: 'self',
      data: vaultSaltHmacData(['A-1', 'B-1']),
      seekPermission: false
    }, ADMIN)
    expect(ci).toMatchObject({ vaultId: VAULT_ID, revision: 2, createdAt: 1 })
    expect(ci.keys).toEqual([KEY_A, KEY_B]) // commitment order = meta order

    // The lock really bakes both salted commitments, in that order, without
    // revealing the salt carried by the recovery record.
    expect(bakedCommitments(LockingScript.fromHex(out.lockingScript))).toEqual([
      commitment(PUB_A, ci.salt),
      commitment(PUB_B, ci.salt)
    ])
    expect(out.lockingScript).not.toContain(ci.salt)
  })

  it('rolls the deterministic derivation index and produces a distinct salt and script', async () => {
    await seedMeta()
    const first = await depositToVault(wallet, ADMIN, 250_000)
    const firstOutput = depositArgs().outputs[0]
    wallet.listActions.mockImplementation(async (args: any) => ({
      actions: args.labels?.includes(specOpFailedActions)
        ? []
        : [{
            txid: first.txid,
            reference: 'deposit-ref',
            status: 'completed',
            labels: ['vault', 'vault-deposit'],
            outputs: [{ ...firstOutput, spendable: false, outputIndex: 0 }]
          }]
    }))
    await depositToVault(wallet, ADMIN, 250_000)
    const outs = wallet.createAction.mock.calls
      .map(([a]: [any]) => a)
      .filter((a: any) => a.labels?.includes('vault-deposit'))
      .map((a: any) => a.outputs[0])
    const records = outs.map((o: any) => decodeVaultInstructions(o.customInstructions)!)
    const salts = records.map(ci => ci.salt)
    expect(records.map(ci => Number(ci.saltKeyId))).toEqual([1, 2])
    expect(salts[0]).not.toBe(salts[1])
    expect(outs[0].lockingScript).not.toBe(outs[1].lockingScript)
  })

  it('allows the same mnemonic, numeric key ID, and YubiKey set to reuse a salt across networks', async () => {
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000)

    vaultStore.configureScope({ identityKey: SCOPE_IDENTITY, chain: 'main' })
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000)

    const outputs = wallet.createAction.mock.calls
      .map(([args]) => args)
      .filter(args => args.labels?.includes('vault-deposit'))
      .map(args => args.outputs[0])
    const [testRecord, mainRecord] = outputs.map(output =>
      decodeVaultInstructions(output.customInstructions)!
    )
    expect(testRecord).toMatchObject({ saltKeyId: '1', chain: 'test' })
    expect(mainRecord).toMatchObject({ saltKeyId: '1', chain: 'main' })
    expect(mainRecord.salt).toBe(testRecord.salt)
    expect(outputs[1].lockingScript).toBe(outputs[0].lockingScript)
  })

  it('frames concatenated YubiKey serials so different lists cannot share HMAC data', () => {
    expect(vaultSaltHmacData(['1', '23'])).not.toEqual(vaultSaltHmacData(['12', '3']))
    expect(vaultSaltHmacData(['A-1', 'B-1'])).toEqual([
      2,
      3, ...Utils.toArray('A-1', 'utf8'),
      3, ...Utils.toArray('B-1', 'utf8')
    ])
  })

  it('serializes simultaneous deposits so each observes the previous HD salt index', async () => {
    await seedMeta()
    const realCreate = wallet.createAction.getMockImplementation()!
    let pendingOutput: any
    let completedOutput: any
    let completedTxid: string | undefined
    wallet.createAction.mockImplementation(async (args: any, originator: string) => {
      if (args.labels?.includes('vault-deposit')) pendingOutput = args.outputs[0]
      const result = await realCreate(args, originator)
      if (args.options?.sendWith) {
        completedOutput = pendingOutput
        completedTxid = args.options.sendWith[0]
      }
      return result
    })
    wallet.listActions.mockImplementation(async (args: any) => ({
      actions: args.labels?.includes(specOpFailedActions) || !completedOutput
        ? []
        : [{
            txid: completedTxid,
            reference: 'completed-deposit',
            status: 'completed',
            labels: ['vault', 'vault-deposit'],
            outputs: [{ ...completedOutput, spendable: false, outputIndex: 0 }]
          }]
    }))

    await Promise.all([
      depositToVault(wallet, ADMIN, 250_000),
      depositToVault(wallet, ADMIN, 250_000)
    ])

    const ids = wallet.createAction.mock.calls
      .map(([args]) => args)
      .filter(args => args.labels?.includes('vault-deposit'))
      .map(args => decodeVaultInstructions(args.outputs[0].customInstructions)!.saltKeyId)
    expect(ids).toEqual(['1', '2'])
  })

  it('fails before createAction if the wallet cannot derive a canonical salt HMAC', async () => {
    await seedMeta()
    wallet.createHmac.mockResolvedValue({ hmac: [0xff] })
    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'template-invalid' })
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('rolls past a completed and already-spent Vault output salt index', async () => {
    await seedMeta()
    const { salt, saltKeyId } = fixtureSalt(1)
    const lock = buildLock({ commitments: [PUB_A, PUB_B].map(pubkey => commitment(pubkey, salt)), saltHex64: salt })
    const customInstructions = encodeVaultInstructions({
      v: 6,
      type: 'R1C',
      salt,
      saltKeyId,
      chain: 'test',
      vaultId: VAULT_ID,
      revision: 2,
      createdAt: 1,
      keys: [KEY_A, KEY_B]
    })
    wallet.listActions.mockImplementation(async (args: any) => ({
      actions: args.labels?.includes(specOpFailedActions)
        ? []
        : [{
            txid: 'cd'.repeat(32),
            reference: 'spent-vault-output',
            status: 'completed',
            outputs: [{
              satoshis: 250_000,
              spendable: false,
              customInstructions,
              lockingScript: lock.toHex(),
              outputIndex: 0,
              basket: VAULT_BASKET
            }]
          }]
    }))
    await expect(depositToVault(wallet, ADMIN, 250_000)).resolves.toMatchObject({ txid: expect.any(String) })
    expect(wallet.createHmac).toHaveBeenCalledTimes(2)
    const created = depositArgs().outputs[0]
    const createdInstructions = decodeVaultInstructions(created.customInstructions)!
    expect(createdInstructions.saltKeyId).toBe('2')
    expect(createdInstructions.salt).not.toBe(salt)
    expect(created.lockingScript).not.toBe(lock.toHex())
  })

  it('keeps prior-enrollment salts globally unique without blocking a drained Vault from being enrolled again', async () => {
    await seedMeta()
    const priorVaultId = 'ef'.repeat(32)
    const { salt, saltKeyId } = fixtureSalt(41)
    const lockingScript = buildLock({
      commitments: [KEY_A, KEY_B].map(key => commitment(key.pubkey, salt)),
      saltHex64: salt
    }).toHex()
    wallet.listActions.mockImplementation(async (args: any) => ({
      // A restored/imported action may have lost its advisory Vault labels.
      // The wallet-global salt inventory must inspect all ordinary history.
      actions: Array.isArray(args.labels) && args.labels.length === 0
        ? [{
            txid: 'ce'.repeat(32),
            reference: 'spent-prior-enrollment',
            status: 'completed',
            inputs: [],
            outputs: [{
              satoshis: 250_000,
              spendable: false,
              customInstructions: encodeVaultInstructions({
                v: 6,
                type: 'R1C',
                salt,
                saltKeyId,
                chain: 'test',
                vaultId: priorVaultId,
                revision: 1,
                createdAt: 99,
                keys: [KEY_A, KEY_B]
              }),
              lockingScript,
              outputIndex: 0,
              basket: VAULT_BASKET
            }]
          }]
        : []
    }))

    await expect(depositToVault(wallet, ADMIN, 250_000)).resolves.toMatchObject({ txid: expect.any(String) })
    const current = decodeVaultInstructions(depositArgs().outputs[0].customInstructions)!
    expect(current.vaultId).toBe(VAULT_ID)
    expect(Number(current.saltKeyId)).toBe(42)
    expect(current.salt).not.toBe(salt)
    expect(wallet.listActions.mock.calls.some(([args]) => Array.isArray(args.labels) && args.labels.length === 0)).toBe(true)
  })

  it('rejects historical salt metadata whose numeric key ID does not derive its recorded HMAC', async () => {
    await seedMeta()
    const claimed = fixtureSalt(42)
    const saltKeyId = '41'
    const lockingScript = buildLock({
      commitments: [KEY_A, KEY_B].map(key => commitment(key.pubkey, claimed.salt)),
      saltHex64: claimed.salt
    }).toHex()
    wallet.listActions.mockImplementation(async (args: any) => ({
      actions: args.labels?.includes(specOpFailedActions)
        ? []
        : [{
            txid: 'dd'.repeat(32),
            reference: 'poisoned-high-water',
            status: 'completed',
            outputs: [{
              satoshis: 250_000,
              spendable: false,
              customInstructions: encodeVaultInstructions({
                v: 6,
                type: 'R1C',
                salt: claimed.salt,
                saltKeyId,
                chain: 'test',
                vaultId: VAULT_ID,
                revision: 2,
                createdAt: 1,
                keys: [KEY_A, KEY_B]
              }),
              lockingScript,
              outputIndex: 0,
              basket: VAULT_BASKET
            }]
          }]
    }))

    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({
      code: 'template-invalid',
      message: 'Vault salt derivation 41 does not belong to this wallet'
    })
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('rejects historical metadata that forks the active revision to a different ordered key set', async () => {
    await seedMeta()
    const { salt, saltKeyId } = fixtureSalt(41, [KEY_A.serial, KEY_C.serial])
    const keys = [KEY_A, KEY_C]
    const lockingScript = buildLock({
      commitments: keys.map(key => commitment(key.pubkey, salt)),
      saltHex64: salt
    }).toHex()
    wallet.listActions.mockImplementation(async (args: any) => ({
      actions: args.labels?.includes(specOpFailedActions)
        ? []
        : [{
            txid: 'de'.repeat(32),
            reference: 'forked-current-revision',
            status: 'completed',
            outputs: [{
              satoshis: 250_000,
              spendable: false,
              customInstructions: encodeVaultInstructions({
                v: 6,
                type: 'R1C',
                salt,
                saltKeyId,
                chain: 'test',
                vaultId: VAULT_ID,
                revision: 2,
                createdAt: 1,
                keys
              }),
              lockingScript,
              outputIndex: 0,
              basket: VAULT_BASKET
            }]
          }]
    }))

    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({
      code: 'template-invalid',
      message: 'Vault history conflicts with the active vault enrollment'
    })
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('deduplicates exact current/history aliases but rejects a conflicting representation of the same outpoint', async () => {
    await seedMeta()
    const current = vaultFixture(250_000, [PUB_A, PUB_B])
    const txid = current.src.id('hex')
    serveVaultOutputs([{ ...current, outpoint: `${txid}:0` }])
    const historyOutput = (fixture: VaultFixture) => ({
      satoshis: fixture.satoshis,
      spendable: false,
      customInstructions: fixture.customInstructions,
      lockingScript: fixture.lockingScript.toHex(),
      outputIndex: 0,
      basket: VAULT_BASKET
    })
    wallet.listActions.mockImplementation(async (args: any) => ({
      actions: args.labels?.includes(specOpFailedActions)
        ? []
        : [{
            txid: txid.toUpperCase(),
            reference: 'same-current-output',
            status: 'completed',
            outputs: [historyOutput(current)]
          }]
    }))

    await expect(depositToVault(wallet, ADMIN, 250_000)).resolves.toMatchObject({ txid: expect.any(String) })

    const conflicting = vaultFixture(250_000, [PUB_A, PUB_B])
    wallet.createAction.mockClear()
    wallet.listActions.mockImplementation(async (args: any) => ({
      actions: args.labels?.includes(specOpFailedActions)
        ? []
        : [{
            txid: txid.toUpperCase(),
            reference: 'conflicting-current-output',
            status: 'completed',
            outputs: [historyOutput(conflicting)]
          }]
    }))
    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({
      code: 'template-invalid',
      message: 'One Vault output has conflicting authenticated representations'
    })
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('rejects two historical rows that assign different valid locks and salt metadata to one transaction output', async () => {
    await seedMeta()
    const first = vaultFixture(250_000, [PUB_A, PUB_B])
    const second = vaultFixture(250_000, [PUB_A, PUB_B])
    const txid = 'cf'.repeat(32)
    const historyOutput = (fixture: VaultFixture) => ({
      satoshis: fixture.satoshis,
      spendable: false,
      customInstructions: fixture.customInstructions,
      lockingScript: fixture.lockingScript.toHex(),
      outputIndex: 0,
      basket: VAULT_BASKET
    })
    wallet.listActions.mockImplementation(async (args: any) => ({
      actions: args.labels?.includes(specOpFailedActions)
        ? []
        : [
            { txid, reference: 'history-a', status: 'completed', outputs: [historyOutput(first)] },
            { txid, reference: 'history-b', status: 'completed', outputs: [historyOutput(second)] }
          ]
    }))

    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({
      code: 'template-invalid',
      message: 'One Vault output has conflicting authenticated representations'
    })
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('requires possession proof for at least two recovered keys before accepting net-new funds', async () => {
    await vaultStore.setMeta({
      v: 6,
      vaultId: VAULT_ID,
      revision: 2,
      createdAt: 1,
      keys: [KEY_A, KEY_B],
      recovery: { required: true, adoptedSerials: ['A-1'] }
    })
    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'key-not-adopted' })
    expect(wallet.createAction).not.toHaveBeenCalled()

    await vaultStore.setMeta({
      v: 6,
      vaultId: VAULT_ID,
      revision: 2,
      createdAt: 1,
      keys: [KEY_A, KEY_B],
      recovery: { required: true, adoptedSerials: ['A-1', 'B-1'] }
    })
    await expect(depositToVault(wallet, ADMIN, 250_000)).resolves.toMatchObject({ txid: expect.any(String) })
  })

  describe('validates the held deposit transaction before sendWith', () => {
    const expectDepositRejected = async (abortExpected = true): Promise<void> => {
      await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'no-transaction' })
      if (abortExpected) expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'deposit-ref' }, ADMIN)
      else expect(wallet.abortAction).not.toHaveBeenCalled()
      expect(requestVaultSigner).not.toHaveBeenCalled()
      expect(wallet.createAction.mock.calls.some(([args]) => args.options?.sendWith)).toBe(false)
    }

    it('rejects a changed R1C destination script', async () => {
      await seedMeta()
      tamperNextSignable(tx => { tx.outputs[0].lockingScript = new P2PKH().lock(Utils.toArray('77'.repeat(20), 'hex')) })
      await expectDepositRejected()
    })

    it('rejects a changed R1C destination value', async () => {
      await seedMeta()
      tamperNextSignable(tx => { tx.outputs[0].satoshis-- })
      await expectDepositRejected()
    })

    it('rejects an injected external output', async () => {
      await seedMeta()
      tamperNextSignable(tx => {
        tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(Utils.toArray('88'.repeat(20), 'hex')) })
      })
      await expectDepositRejected()
    })

    it('rejects unreasonable fee burn', async () => {
      await seedMeta()
      tamperNextSignable(tx => { tx.outputs[1].satoshis = 1 })
      await expectDepositRejected()
    })

    it('revalidates after wallet signing and rejects a signAction mutation', async () => {
      await seedMeta()
      const realSign = wallet.signAction.getMockImplementation()!
      wallet.signAction.mockImplementationOnce(async (...args: any[]) => {
        const signed = await realSign(...(args as [unknown, string]))
        const tx = Transaction.fromAtomicBEEF(signed.tx)
        tx.outputs[0].satoshis--
        return { ...signed, tx: tx.toAtomicBEEF(), txid: tx.id('hex') }
      })
      await expectDepositRejected()
    })
  })

  it('commits to the CURRENT key list — three keys, three commitments, the three-key lock length', async () => {
    await seedMeta([KEY_A, KEY_B, KEY_C])
    await depositToVault(wallet, ADMIN, 250_000)
    const out = depositArgs().outputs[0]
    expect(Utils.toArray(out.lockingScript, 'hex')).toHaveLength(R1C_LOCK_LEN(3))
    const ci = decodeVaultInstructions(out.customInstructions)!
    expect(ci.keys).toEqual([KEY_A, KEY_B, KEY_C])
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
      await expect(
        depositToVault(wallet, ADMIN, 250_000, { vaultEnabled: () => false, isOnline })
      ).rejects.toMatchObject({ code: 'not-released' })
      expect(isOnline).not.toHaveBeenCalled()
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('reads isVaultEnabled() when opts omit the flag', async () => {
      await seedMeta()
      ;(isVaultEnabled as jest.Mock).mockReturnValueOnce(false)
      await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'not-released' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('below-dust under VAULT_DEPOSIT_MIN, and for a non-integer or unsafe amount', async () => {
      await seedMeta()
      await expect(depositToVault(wallet, ADMIN, VAULT_DEPOSIT_MIN - 1)).rejects.toMatchObject({ code: 'below-dust' })
      await expect(depositToVault(wallet, ADMIN, 250_000.5)).rejects.toMatchObject({ code: 'below-dust' })
      await expect(depositToVault(wallet, ADMIN, Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({ code: 'below-dust' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('requires-online before key checks', async () => {
      await seedMeta()
      await expect(
        depositToVault(wallet, ADMIN, 250_000, { isOnline: async () => false })
      ).rejects.toMatchObject({ code: 'requires-online' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('backup-off when no private backup service is configured', async () => {
      await seedMeta()
      ;(isBackupPushEnabled as jest.Mock).mockClear()
      ;(getBackupUrl as jest.Mock).mockReturnValueOnce('')
      await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'backup-off' })
      expect(isBackupPushEnabled).not.toHaveBeenCalled()
      expect(wallet.listOutputs).not.toHaveBeenCalled()
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('backup-off when private backup push is opted out', async () => {
      await seedMeta()
      ;(isBackupPushEnabled as jest.Mock).mockResolvedValueOnce(false)
      await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'backup-off' })
      expect(wallet.listOutputs).not.toHaveBeenCalled()
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('uses the injected private-backup gate before reading metadata or allocating a salt', async () => {
      await seedMeta()
      const backupEnabled = jest.fn(async () => false)
      await expect(depositToVault(wallet, ADMIN, 250_000, { backupEnabled })).rejects.toMatchObject({ code: 'backup-off' })
      expect(backupEnabled).toHaveBeenCalledTimes(1)
      expect(wallet.createHmac).not.toHaveBeenCalled()
      expect(wallet.listOutputs).not.toHaveBeenCalled()
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('not-enrolled with no key list', async () => {
      await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'not-enrolled' })
    })

    it('rejects a one-key metadata state before a deposit can rely on it', async () => {
      await expect(seedMeta([KEY_A])).rejects.toMatchObject({ code: 'template-invalid' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })
  })

  it('no-transaction when the wallet returns neither a txid nor a tx', async () => {
    await seedMeta()
    wallet.createAction.mockResolvedValueOnce({})
    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'no-transaction' })
  })

  it.each([
    ['missing results', undefined],
    ['an unrelated txid', [{ txid: '00'.repeat(32), status: 'sending' }]],
    ['an unknown status', [{ txid: 'requested', status: 'unknown' }]],
    ['duplicate results', [
      { txid: 'requested', status: 'sending' },
      { txid: 'requested', status: 'unproven' }
    ]]
  ])('keeps a signed deposit held when sendWith returns %s', async (_case, configured) => {
    await seedMeta()
    const realCreate = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (args: any, originator: string) => {
      if (!args?.options?.sendWith) return await realCreate(args, originator)
      const txid = args.options.sendWith[0]
      const sendWithResults = configured?.map(result => ({
        ...result,
        txid: result.txid === 'requested' ? txid.toUpperCase() : result.txid
      }))
      return sendWithResults === undefined ? {} : { sendWithResults }
    })

    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'no-transaction' })
    expect(wallet.signAction).toHaveBeenCalledTimes(1)
    expect(wallet.createAction.mock.calls.filter(([args]) => args.options?.sendWith)).toHaveLength(1)
    // Broadcast was attempted, so even an ambiguous response can never free
    // the held transaction's inputs.
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('accepts one case-insensitive matching unproven sendWith result', async () => {
    await seedMeta()
    const realCreate = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (args: any, originator: string) => {
      if (!args?.options?.sendWith) return await realCreate(args, originator)
      return { sendWithResults: [{ txid: args.options.sendWith[0].toUpperCase(), status: 'unproven' }] }
    })

    await expect(depositToVault(wallet, ADMIN, 250_000)).resolves.toMatchObject({ txid: expect.any(String) })
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })
})

describe('withdrawFromVault', () => {
  it('invalidates an in-flight scope-A scan before any action or scope-B mutation', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    const scopeBMeta = {
      v: 6 as const,
      vaultId: '22'.repeat(32),
      revision: 1,
      createdAt: 22,
      keys: [KEY_A, KEY_B]
    }
    const realList = wallet.listOutputs.getMockImplementation()!
    let switched = false
    wallet.listOutputs.mockImplementation(async (...args: any[]) => {
      const result = await realList(...(args as [unknown, string]))
      if (!switched) {
        switched = true
        vaultStore.clearScope()
        vaultStore.configureScope({ identityKey: `03${'33'.repeat(32)}`, chain: 'main' })
        await vaultStore.setMeta(scopeBMeta)
      }
      return result
    })

    await expect(withdrawAll()).rejects.toMatchObject({ code: 'scope-changed' })
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(await vaultStore.getMeta()).toEqual(scopeBMeta)
  })

  it('paginates entire transactions + customInstructions, and creates a version-1 action with the R1C unlock length, BEEF, and strict options', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    await withdrawAll()

    const [listArgs] = wallet.listOutputs.mock.calls[0]
    expect(listArgs).toEqual({
      basket: VAULT_BASKET,
      include: 'entire transactions',
      includeCustomInstructions: true,
      limit: 64,
      offset: 0
    })

    const [caArgs] = wallet.createAction.mock.calls[0]
    // Fixed regardless of the caller's `reason` (the ceremony's NFC prompt
    // text, 'Withdraw all' here) — the action's own description no longer
    // tracks it, so the amount never leaks into what shows in the activity
    // list for a withdrawal.
    expect(caArgs.description).toBe('Vault withdrawal')
    expect(caArgs.version).toBe(1)
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

  it('produces unlocking scripts the strict interpreter accepts against the real version-1 signable transaction, keyed by input index', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    const r = await withdrawAll()
    expect(r.txid).toBe('feedface'.repeat(8))
    expect(lastSignable!.version).toBe(1)
    validateSpends(fx)
  }, 60_000)

  it('rejects a toolbox-injected funding input before the YubiKey signs', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B])]
    await seedVault(fx, [KEY_A, KEY_B], { fundingFirst: true })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'no-transaction' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
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

  it('hands the signed transaction to the monitor without delayed broadcast and stamps lastUsedSerial', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    await withdrawAll()
    const [saArgs] = wallet.signAction.mock.calls[0]
    expect(saArgs.reference).toBe('ref-1')
    expect(saArgs.options).toEqual({ acceptDelayedBroadcast: false })
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
    const action = wallet.createAction.mock.calls[0][0]
    expect(r.cappedInputs).toBe(2)
    expect(r.unreachable.count).toBe(0)
    expect(action.inputs).toHaveLength(VAULT_MAX_INPUTS)
    const selectedSources = Beef.fromBinary(action.inputBEEF)
    for (const selected of fx.slice(0, VAULT_MAX_INPUTS)) {
      expect(selectedSources.findTxid(selected.src.id('hex'))).toBeDefined()
    }
    for (const unselected of fx.slice(VAULT_MAX_INPUTS)) {
      expect(selectedSources.findTxid(unselected.src.id('hex'))).toBeUndefined()
    }
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

  it('template-invalid when the real lock disagrees with its recovery record — before any reservation or tap', async () => {
    const liar = vaultFixture(300_000, [PUB_A, PUB_B], [PUB_B]) // record says A+B, lock says B
    await seedVault([liar])
    const err = await withdrawAll().catch(e => e)
    expect(err).toMatchObject({ code: 'template-invalid' })
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

  it('fails closed when a future-only vault basket contains legacy or malformed metadata', async () => {
    await seedMeta()
    const fixture = vaultFixture(250_000, [PUB_A, PUB_B])
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        { outpoint: fixture.outpoint, satoshis: 250_000, customInstructions: JSON.stringify({ v: 3, type: 'K1', keyID: 'bip32/0' }) }
      ],
      BEEF: stitchBeef([fixture])
    })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'template-invalid' })
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

  it.each([NaN, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
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
    expect(ci.keys).toEqual([KEY_A, KEY_B, KEY_C])
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

  it('requires private backup only when a withdrawal creates a re-vaulted remainder', async () => {
    await seedVault([vaultFixture(500_000, [PUB_A, PUB_B]), vaultFixture(500_000, [PUB_A, PUB_B])])
    await expect(
      withdrawFromVault(wallet, ADMIN, 600_000, 'Withdraw', 'A-1', { backupEnabled: async () => false })
    ).rejects.toMatchObject({ code: 'backup-off' })
    expect(wallet.createAction).not.toHaveBeenCalled()

    await expect(withdrawAll({ backupEnabled: async () => false })).resolves.toMatchObject({ txid: expect.any(String) })
  }, 60_000)

  // ── the version invariant and D4b (spec §2.6, §4.2 step 5) ─────────────

  it('bad-version: a signable transaction that is not version 1 is aborted before any signature', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    const real = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementationOnce(async (args: any, o: string) => real({ ...args, version: 2 }, o))
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'bad-version' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  describe('rejects wallet-core transaction-plan tampering before the YubiKey signs', () => {
    const expectRejectedBeforeTap = async (): Promise<void> => {
      await expect(withdrawAll()).rejects.toMatchObject({ code: 'no-transaction' })
      expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
      expect(requestVaultSigner).not.toHaveBeenCalled()
      expect(wallet.signAction).not.toHaveBeenCalled()
    }

    it('rejects a missing selected input', async () => {
      await seedVault([vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B])])
      tamperNextSignable(tx => { tx.inputs.pop() })
      await expectRejectedBeforeTap()
    })

    it('rejects a duplicate selected input', async () => {
      const fx = [vaultFixture(300_000, [PUB_A, PUB_B])]
      await seedVault(fx)
      tamperNextSignable(tx => {
        tx.addInput({
          sourceTransaction: fx[0].src,
          sourceOutputIndex: 0,
          sequence: 0xffffffff,
          unlockingScript: new UnlockingScript([])
        })
      })
      await expectRejectedBeforeTap()
    })

    it('rejects an injected external output', async () => {
      await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
      tamperNextSignable(tx => {
        tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(Utils.toArray('77'.repeat(20), 'hex')) })
      })
      await expectRejectedBeforeTap()
    })

    it('rejects a non-P2PKH withdrawal destination', async () => {
      await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
      tamperNextSignable(tx => { tx.outputs[0].lockingScript = LockingScript.fromHex('006a') })
      await expectRejectedBeforeTap()
    })

    it('rejects a changed destination value that makes the fee negative', async () => {
      await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
      tamperNextSignable(tx => { tx.outputs[0].satoshis = 300_001 })
      await expectRejectedBeforeTap()
    })

    it('rejects an unreasonable fee or omitted change', async () => {
      await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
      tamperNextSignable(tx => { tx.outputs = [] })
      await expectRejectedBeforeTap()
    })

    it('rejects a byte-changed re-vault output', async () => {
      await seedVault([vaultFixture(500_000, [PUB_A, PUB_B]), vaultFixture(500_000, [PUB_A, PUB_B])])
      tamperNextSignable(tx => { tx.outputs[0].lockingScript = new P2PKH().lock(Utils.toArray('88'.repeat(20), 'hex')) })
      await expect(withdrawFromVault(wallet, ADMIN, 600_000, 'Withdraw', 'A-1')).rejects.toMatchObject({ code: 'no-transaction' })
      expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
      expect(requestVaultSigner).not.toHaveBeenCalled()
      expect(wallet.signAction).not.toHaveBeenCalled()
    })
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

  test('with a storage lookup, heals from one query after the action-history safety scan', async () => {
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
    expect(wallet.listActions).toHaveBeenCalledTimes(2)
    expect(wallet.listActions.mock.calls[0][0]).toMatchObject({ labels: [], includeInputSourceLockingScripts: true })
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
    expect(wallet.listActions).toHaveBeenCalledTimes(2) // held-deposit reconciliation + hidden-reservation safety scan
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
    expect(estimateRelockFee(1, R1C_LOCK_LEN(2))).toBe(5280)
    expect(estimateRelockFee(32, R1C_LOCK_LEN(3))).toBe(14190)
    expect(estimateRelockFee(1, R1C_LOCK_LEN(2), 50)).toBe(2640)
    expect(estimateRelockFee(0, R1C_LOCK_LEN(2))).toBe(5060)
  })
})

describe('relockVault', () => {
  const relock = (opts?: Parameters<typeof relockVault>[4]) => relockVault(wallet, ADMIN, 'Re-lock vault', 'A-1', opts)

  it('spends everything the chosen key can open into ONE fresh vault output of acc − fee committed to the CURRENT key set, with no withdrawal output', async () => {
    const fx = [vaultFixture(500_000, [PUB_A, PUB_B]), vaultFixture(500_000, [PUB_A, PUB_B])]
    await seedVault(fx, [KEY_A, KEY_B, KEY_C]) // a key was ADDED since these deposits
    const r = await relock()
    expect(r).toEqual({ txid: expect.any(String), cappedInputs: 0, unreachable: { count: 0, satoshis: 0, keys: [] } })

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.description).toBe('Re-lock vault')
    expect(caArgs.version).toBe(1)
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
    expect(ci.keys).toEqual([KEY_A, KEY_B, KEY_C])
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
    expect(decodeVaultInstructions(out.customInstructions)!.keys).toEqual([KEY_A, KEY_B])
    expect(Utils.toArray(out.lockingScript, 'hex')).toHaveLength(R1C_LOCK_LEN(2))
    expect(out.satoshis).toBe(500_000 - estimateRelockFee(1, R1C_LOCK_LEN(2)))
    validateSpends(fx)
  }, 60_000)

  it('keeps a signed re-lock held unless sendWith reports one accepted matching transaction', async () => {
    await seedVault([vaultFixture(500_000, [PUB_A, PUB_B])])
    const realCreate = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (args: any, originator: string) => {
      if (!args?.options?.sendWith) return await realCreate(args, originator)
      const txid = args.options.sendWith[0]
      return {
        sendWithResults: [
          { txid, status: 'unproven' },
          { txid, status: 'unproven' }
        ]
      }
    })

    await expect(relock()).rejects.toMatchObject({ code: 'no-transaction' })
    expect(wallet.signAction).toHaveBeenCalledTimes(1)
    expect(wallet.createAction.mock.calls.filter(([args]) => args?.options?.sendWith)).toHaveLength(1)
    expect(wallet.abortAction).not.toHaveBeenCalled()
  }, 60_000)

  it('too-small-to-relock when acc − fee would fall below the floor — nothing reserved, no tap; exactly the floor passes', async () => {
    await seedVault([vaultFixture(100_000, [PUB_A, PUB_B])])
    const err = await relock().catch(e => e)
    expect(err).toMatchObject({ code: 'too-small-to-relock' })
    expect(err.message).toContain(String(100_000 - estimateRelockFee(1, R1C_LOCK_LEN(2))))
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

  it('requires private backup before a re-lock lists or taps Vault outputs', async () => {
    await seedVault([vaultFixture(500_000, [PUB_A, PUB_B])])
    await expect(relock({ backupEnabled: async () => false })).rejects.toMatchObject({ code: 'backup-off' })
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()
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

describe('two-phase key removal reconciliation', () => {
  const beginRemoval = async (): Promise<VaultFixture[]> => {
    const fixtures = [vaultFixture(500_000, [PUB_A, PUB_B, KEY_C.pubkey])]
    await seedVault(fixtures, [KEY_A, KEY_B, KEY_C])
    const begun = await beginVaultKeyRemoval(wallet, ADMIN, KEY_C.serial)
    expect(begun.complete).toBe(false)
    expect(begun.meta.pendingRemoval).toMatchObject({ key: KEY_C, state: 'prepared' })
    return fixtures
  }

  const historyAction = (
    output: any,
    sources: VaultFixture[],
    status: string,
    txid = 'aa'.repeat(32),
    reference = `ref-${txid.slice(0, 4)}`
  ) => ({
    txid,
    reference,
    status,
    labels: ['vault', 'vault-relock'],
    inputs: sources.map(source => ({
      sourceOutpoint: source.outpoint,
      sourceSatoshis: source.satoshis,
      sourceLockingScript: source.lockingScript.toHex()
    })),
    outputs: [{
      satoshis: output.satoshis,
      spendable: true,
      customInstructions: output.customInstructions,
      lockingScript: output.lockingScript,
      outputIndex: 0,
      basket: VAULT_BASKET
    }],
    sourceFixtures: sources
  })

  const serveHistory = (actions: any[]): void => {
    const sourceFixtures = new Map<string, VaultFixture>()
    for (const action of actions) {
      for (const source of action.sourceFixtures ?? []) sourceFixtures.set(source.outpoint, source)
    }
    const sourceActions = [...sourceFixtures.values()].map(source => ({
      txid: source.outpoint.split('.')[0],
      reference: `source-${source.outpoint.slice(0, 8)}`,
      status: 'completed',
      labels: ['vault', 'vault-deposit'],
      inputs: [],
      outputs: [{
        satoshis: source.satoshis,
        spendable: false,
        customInstructions: source.customInstructions,
        lockingScript: source.lockingScript.toHex(),
        outputIndex: Number(source.outpoint.split('.')[1]),
        basket: VAULT_BASKET
      }]
    }))
    const completeHistory = [...actions, ...sourceActions]
    wallet.listActions.mockImplementation(async (args: any) => ({
      actions: args.labels?.includes(specOpFailedActions)
        ? completeHistory.filter(action => action.status === 'failed')
        : completeHistory.filter(action => action.status !== 'failed')
    }))
  }

  const replacementForCurrentMeta = async (
    satoshis = 490_000,
    chain: VaultSaltChain = 'test'
  ): Promise<any> => {
    const meta = (await vaultStore.getMeta())!
    const { salt, saltKeyId } = fixtureSalt(undefined, meta.keys.map(key => key.serial))
    const lockingScript = buildLock({
      commitments: meta.keys.map(key => commitment(key.pubkey, salt)),
      saltHex64: salt
    }).toHex()
    return {
      satoshis,
      lockingScript,
      customInstructions: encodeVaultInstructions({
        v: 6,
        type: 'R1C',
        salt,
        saltKeyId,
        chain,
        vaultId: meta.vaultId,
        revision: meta.revision,
        createdAt: meta.createdAt,
        keys: meta.keys
      })
    }
  }

  it('aborts a provably unbroadcast unsigned removal reservation, rescans the restored old source, and keeps the tombstone for retry', async () => {
    const old = await beginRemoval()
    const replacementOutput = await replacementForCurrentMeta()
    serveVaultOutputs([])
    serveHistory([{
      ...historyAction(replacementOutput, old, 'unsigned', undefined as any, 'crash-ref'),
      txid: undefined
    }])
    wallet.abortAction.mockImplementation(async ({ reference }: any) => {
      expect(reference).toBe('crash-ref')
      serveVaultOutputs(old)
      serveHistory([])
      return {}
    })

    await expect(finalizeVaultKeyRemoval(wallet, ADMIN)).resolves.toBe(false)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'crash-ref' }, ADMIN)
    expect((await vaultStore.getMeta())!.pendingRemoval).toMatchObject({ key: KEY_C, state: 'prepared' })
  }, 90_000)

  it('finalizes after two zero-authority scans and multiple completed matching relocks without storing txids', async () => {
    const old = await beginRemoval()
    await relockVault(wallet, ADMIN, 'Remove C', 'A-1', { revokePubkey: KEY_C.pubkey })
    const replacementOutput = wallet.createAction.mock.calls.find(([args]) => args.outputs?.[0]?.basket === VAULT_BASKET)![0].outputs[0]
    const replacement = fixtureFromVaultOutput(replacementOutput)
    serveVaultOutputs([replacement])
    serveHistory([
      historyAction(replacementOutput, old, 'completed', 'aa'.repeat(32), 'ref-aa'),
      historyAction(replacementOutput, old, 'completed', 'bb'.repeat(32), 'ref-bb')
    ])

    await expect(finalizeVaultKeyRemoval(wallet, ADMIN)).resolves.toBe(true)
    const meta = (await vaultStore.getMeta())!
    expect(meta.pendingRemoval).toBeUndefined()
    expect(meta.keys).toEqual([KEY_A, KEY_B])
    expect(JSON.stringify(meta)).not.toContain('aa'.repeat(32))
    expect(JSON.stringify(meta)).not.toContain('bb'.repeat(32))
    expect(wallet.listOutputs.mock.calls.length).toBeGreaterThanOrEqual(2)
  }, 90_000)

  it('derives prepared → broadcast from an authenticated pending relock after a crash, but does not finalize it', async () => {
    const old = await beginRemoval()
    await relockVault(wallet, ADMIN, 'Remove C', 'A-1', { revokePubkey: KEY_C.pubkey })
    const replacementOutput = wallet.createAction.mock.calls.find(([args]) => args.outputs?.[0]?.basket === VAULT_BASKET)![0].outputs[0]
    const replacement = fixtureFromVaultOutput(replacementOutput)
    const afterRelock = (await vaultStore.getMeta())!
    await vaultStore.setMeta({
      ...afterRelock,
      pendingRemoval: { ...afterRelock.pendingRemoval!, state: 'prepared' }
    })
    serveVaultOutputs([replacement])
    serveHistory([historyAction(replacementOutput, old, 'unproven')])

    await expect(finalizeVaultKeyRemoval(wallet, ADMIN)).resolves.toBe(false)
    expect((await vaultStore.getMeta())!.pendingRemoval?.state).toBe('broadcast')
  }, 90_000)

  it('keeps the tombstone while a matching relock is failed', async () => {
    const old = await beginRemoval()
    await relockVault(wallet, ADMIN, 'Remove C', 'A-1', { revokePubkey: KEY_C.pubkey })
    const replacementOutput = wallet.createAction.mock.calls.find(([args]) => args.outputs?.[0]?.basket === VAULT_BASKET)![0].outputs[0]
    const replacement = fixtureFromVaultOutput(replacementOutput)
    serveVaultOutputs([replacement])
    serveHistory([historyAction(replacementOutput, old, 'failed')])

    await expect(finalizeVaultKeyRemoval(wallet, ADMIN)).resolves.toBe(false)
    expect((await vaultStore.getMeta())!.pendingRemoval).toBeDefined()
  }, 90_000)

  it.each(['unproven', 'failed'])('does not finalize while a %s ordinary withdrawal hides the old-authority source', async status => {
    const old = await beginRemoval()
    serveVaultOutputs([])
    serveHistory([{
      txid: 'dd'.repeat(32),
      reference: `ordinary-${status}`,
      status,
      labels: ['vault', 'vault-withdraw'],
      inputs: old.map(source => ({
        sourceOutpoint: source.outpoint,
        sourceSatoshis: source.satoshis,
        sourceLockingScript: source.lockingScript.toHex()
      })),
      outputs: []
    }])

    await expect(finalizeVaultKeyRemoval(wallet, ADMIN)).resolves.toBe(false)
    expect((await vaultStore.getMeta())!.pendingRemoval).toMatchObject({ key: KEY_C, state: 'prepared' })
  })

  it('cannot mark or finalize from a relock whose source never authorized the tombstoned key', async () => {
    await beginRemoval()
    await relockVault(wallet, ADMIN, 'Remove C', 'A-1', { revokePubkey: KEY_C.pubkey })
    const replacementOutput = wallet.createAction.mock.calls.find(([args]) => args.outputs?.[0]?.basket === VAULT_BASKET)![0].outputs[0]
    const replacement = fixtureFromVaultOutput(replacementOutput)
    const wrongSource = vaultFixture(500_000, [PUB_A, PUB_B])
    const afterRelock = (await vaultStore.getMeta())!
    await vaultStore.setMeta({
      ...afterRelock,
      pendingRemoval: { ...afterRelock.pendingRemoval!, state: 'prepared' }
    })
    serveVaultOutputs([replacement])
    serveHistory([historyAction(replacementOutput, [wrongSource], 'completed')])

    await expect(finalizeVaultKeyRemoval(wallet, ADMIN)).resolves.toBe(false)
    expect((await vaultStore.getMeta())!.pendingRemoval?.state).toBe('prepared')
  }, 90_000)

  it('rejects foreign-network relock evidence and preserves the key-removal tombstone', async () => {
    const old = await beginRemoval()
    const foreignReplacement = await replacementForCurrentMeta(490_000, 'main')
    serveVaultOutputs([])
    serveHistory([historyAction(foreignReplacement, old, 'completed')])

    await expect(finalizeVaultKeyRemoval(wallet, ADMIN)).rejects.toMatchObject({
      code: 'template-invalid',
      message: 'Vault output belongs to a different network'
    })
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect((await vaultStore.getMeta())!.pendingRemoval).toMatchObject({ key: KEY_C, state: 'prepared' })
  }, 90_000)

  it('rejects current relock evidence whose salt belongs to another wallet and preserves the tombstone', async () => {
    const old = await beginRemoval()
    const replacement = await replacementForCurrentMeta()
    serveVaultOutputs([])
    serveHistory([historyAction(replacement, old, 'completed')])
    const foreignDeriver = new KeyDeriver(new PrivateKey(43))
    wallet.createHmac.mockImplementation(async (args: any) => ({
      hmac: Hash.sha256hmac(
        foreignDeriver.deriveSymmetricKey(args.protocolID, args.keyID, args.counterparty).toArray(),
        args.data
      )
    }))

    await expect(finalizeVaultKeyRemoval(wallet, ADMIN)).rejects.toMatchObject({
      code: 'template-invalid',
      message: expect.stringContaining('does not belong to this wallet')
    })
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect((await vaultStore.getMeta())!.pendingRemoval).toMatchObject({ key: KEY_C, state: 'prepared' })
  }, 90_000)

  it('does not mark or finalize a removal if wallet scope changes during the relock salt check', async () => {
    const old = await beginRemoval()
    const replacement = await replacementForCurrentMeta()
    serveVaultOutputs([])
    serveHistory([historyAction(replacement, old, 'completed')])
    wallet.createHmac.mockImplementation(async (args: any) => {
      const hmac = Hash.sha256hmac(
        SALT_DERIVER.deriveSymmetricKey(args.protocolID, args.keyID, args.counterparty).toArray(),
        args.data
      )
      vaultStore.configureScope({ identityKey: `03${'44'.repeat(32)}`, chain: 'main' })
      return { hmac }
    })

    await expect(finalizeVaultKeyRemoval(wallet, ADMIN)).rejects.toMatchObject({ code: 'scope-changed' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
    vaultStore.configureScope({ identityKey: SCOPE_IDENTITY, chain: 'test' })
    expect((await vaultStore.getMeta())!.pendingRemoval).toMatchObject({ key: KEY_C, state: 'prepared' })
  }, 90_000)
})

// ── coverage / removal / balance ─────────────────────────────────────────

describe('authenticated vault scans', () => {
  const switchNetworkDuringOutputRead = (): void => {
    wallet.listOutputs.mockImplementationOnce(async () => {
      vaultStore.configureScope({ identityKey: `03${'44'.repeat(32)}`, chain: 'main' })
      return { outputs: [] }
    })
  }

  it('invalidates an in-flight balance read when the wallet network changes', async () => {
    await seedMeta()
    switchNetworkDuringOutputRead()

    await expect(getVaultBalance(wallet, ADMIN)).rejects.toMatchObject({ code: 'scope-changed' })
  })

  it('invalidates an in-flight coverage read when the wallet network changes', async () => {
    await seedMeta()
    switchNetworkDuringOutputRead()

    await expect(getVaultKeyCoverage(wallet, ADMIN)).rejects.toMatchObject({ code: 'scope-changed' })
  })

  it('invalidates an in-flight removal preview when the wallet network changes', async () => {
    await seedMeta()
    switchNetworkDuringOutputRead()

    await expect(orphanedIfRemoved(wallet, ADMIN, PUB_A)).rejects.toMatchObject({ code: 'scope-changed' })
  })

  it('rejects a byte-exact Vault output from a different network domain', async () => {
    const fixture = vaultFixture(100_000, [PUB_A, PUB_B], [PUB_A, PUB_B], 'main')
    serveVaultOutputs([fixture])

    await expect(getVaultBalance(wallet, ADMIN)).rejects.toMatchObject({
      code: 'template-invalid',
      message: 'Vault output belongs to a different network'
    })
  })

  it('rederives every numeric salt key before persisting recovered metadata', async () => {
    const fixture = vaultFixture(100_000, [PUB_A, PUB_B])
    serveVaultOutputs([fixture])

    await expect(recoverVaultMetaFromOutputs(wallet, ADMIN)).resolves.toMatchObject({
      v: 6,
      vaultId: VAULT_ID,
      keys: [KEY_A, KEY_B],
      recovery: { required: true, adoptedSerials: [] }
    })
    const ci = decodeVaultInstructions(fixture.customInstructions)!
    expect(wallet.createHmac).toHaveBeenCalledWith({
      protocolID: [2, 'vault salt'],
      keyID: ci.saltKeyId,
      counterparty: 'self',
      data: vaultSaltHmacData(['A-1', 'B-1']),
      seekPermission: false
    }, ADMIN)
  })

  it('rejects a valid HMAC record whose salt does not rebuild the source lock commitments', async () => {
    const fixture = vaultFixture(100_000, [PUB_A, PUB_B])
    const ci = decodeVaultInstructions(fixture.customInstructions)!
    const replacement = fixtureSalt(2, ['A-1', 'B-1'])
    fixture.customInstructions = encodeVaultInstructions({
      ...ci,
      salt: replacement.salt,
      saltKeyId: replacement.saltKeyId
    })
    serveVaultOutputs([fixture])

    await expect(getVaultBalance(wallet, ADMIN)).rejects.toMatchObject({
      code: 'template-invalid',
      message: expect.stringContaining('recovery metadata does not match its real lock')
    })
  })

  it('refuses recovery metadata whose numeric salt key belongs to another wallet', async () => {
    const fixture = vaultFixture(100_000, [PUB_A, PUB_B])
    serveVaultOutputs([fixture])
    const foreignDeriver = new KeyDeriver(new PrivateKey(43))
    wallet.createHmac.mockImplementation(async (args: any) => ({
      hmac: Hash.sha256hmac(
        foreignDeriver.deriveSymmetricKey(args.protocolID, args.keyID, args.counterparty).toArray(),
        args.data
      )
    }))

    await expect(recoverVaultMetaFromOutputs(wallet, ADMIN)).rejects.toMatchObject({
      code: 'template-invalid',
      message: expect.stringContaining('does not belong to this wallet')
    })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  it('never counts an output whose HMAC salt belongs to another wallet', async () => {
    const fixture = vaultFixture(100_000, [PUB_A, PUB_B])
    serveVaultOutputs([fixture])
    const foreignDeriver = new KeyDeriver(new PrivateKey(43))
    wallet.createHmac.mockImplementation(async (args: any) => ({
      hmac: Hash.sha256hmac(
        foreignDeriver.deriveSymmetricKey(args.protocolID, args.keyID, args.counterparty).toArray(),
        args.data
      )
    }))

    await expect(getVaultBalance(wallet, ADMIN)).rejects.toMatchObject({
      code: 'template-invalid',
      message: expect.stringContaining('does not belong to this wallet')
    })
  })

  const removedPubkey = Utils.toHex(Array.from(p256.getPublicKey(p256.utils.randomSecretKey(), true)))

  it('counts stale outputs in both directions and reports missing and removed keys', async () => {
    const fixtures = [
      vaultFixture(100_000, [PUB_A, PUB_B]),
      vaultFixture(100_000, [PUB_A]),
      vaultFixture(100_000, [PUB_A, PUB_B, removedPubkey])
    ]
    await seedVault(fixtures, [KEY_A, KEY_B])
    expect(await getVaultKeyCoverage(wallet, ADMIN)).toEqual({
      outputs: 3,
      stale: 2,
      missingKeys: [PUB_B],
      removedKeyOutputs: 1
    })
    expect(wallet.listOutputs.mock.calls[0][0]).toMatchObject({
      basket: VAULT_BASKET,
      include: 'entire transactions',
      includeCustomInstructions: true,
      limit: 64,
      offset: 0
    })
  })

  it('keeps current key order and reports each missing key once', async () => {
    const fixtures = [
      vaultFixture(100_000, [PUB_A]),
      vaultFixture(100_000, [PUB_A]),
      vaultFixture(100_000, [PUB_B])
    ]
    await seedVault(fixtures, [KEY_A, KEY_B, KEY_C])
    expect(await getVaultKeyCoverage(wallet, ADMIN)).toEqual({
      outputs: 3,
      stale: 3,
      missingKeys: [PUB_A, PUB_B, KEY_C.pubkey],
      removedKeyOutputs: 0
    })
  })

  it('counts outputs that would be orphaned by a removal', async () => {
    const fixtures = [vaultFixture(100_000, [PUB_A, PUB_B]), vaultFixture(100_000, [PUB_A])]
    await seedVault(fixtures, [KEY_A, KEY_B])
    expect(await orphanedIfRemoved(wallet, ADMIN, PUB_A)).toBe(1)
    expect(await orphanedIfRemoved(wallet, ADMIN, PUB_B)).toBe(0)
  })

  it('sums authenticated source values and returns zero for an empty basket', async () => {
    await seedVault([vaultFixture(3_000, [PUB_A, PUB_B]), vaultFixture(4_500, [PUB_A, PUB_B])])
    expect(await getVaultBalance(wallet, ADMIN)).toBe(7_500)
    wallet.listOutputs.mockResolvedValue({ outputs: [] })
    expect(await getVaultBalance(wallet, ADMIN)).toBe(0)
  })

  it('accepts two distinct outputs that reuse one locking-script hash', async () => {
    const first = vaultFixture(100_000, [PUB_A, PUB_B])
    const secondSource = new Transaction()
    secondSource.addOutput({ satoshis: first.satoshis, lockingScript: first.lockingScript })
    // Change the transaction ID while preserving output zero byte-for-byte.
    secondSource.addOutput({
      satoshis: 1,
      lockingScript: new P2PKH().lock(Utils.toArray('ab'.repeat(20), 'hex'))
    })
    const second: VaultFixture = {
      ...first,
      outpoint: `${secondSource.id('hex')}.0`,
      src: secondSource
    }
    await seedVault([first, second])

    await expect(getVaultBalance(wallet, ADMIN)).resolves.toBe(200_000)
  })

  it('continues after a short page while the stable reported total says rows remain', async () => {
    await seedMeta()
    const fixtures = [vaultFixture(3_000, [PUB_A, PUB_B]), vaultFixture(4_500, [PUB_A, PUB_B])]
    wallet.listOutputs.mockImplementation(async (args: any) => {
      const index = args.offset
      if (index >= fixtures.length) return { outputs: [], totalOutputs: fixtures.length }
      const fixture = fixtures[index]
      return {
        outputs: [{ outpoint: fixture.outpoint, satoshis: fixture.satoshis, customInstructions: fixture.customInstructions }],
        BEEF: stitchBeef([fixture]),
        totalOutputs: fixtures.length
      }
    })
    expect(await getVaultBalance(wallet, ADMIN)).toBe(7_500)
    expect(wallet.listOutputs.mock.calls.map(([args]) => args.offset)).toEqual([0, 1])
  })

  it('authenticates more than one full page from page-local source BEEF', async () => {
    await seedMeta()
    const fixtures = Array.from({ length: 65 }, (_, index) => vaultFixture(100_000 + index, [PUB_A, PUB_B]))
    wallet.listOutputs.mockImplementation(async (args: any) => {
      const page = fixtures.slice(args.offset, args.offset + args.limit)
      return {
        outputs: page.map(fixture => ({
          outpoint: fixture.outpoint,
          satoshis: fixture.satoshis,
          customInstructions: fixture.customInstructions
        })),
        BEEF: page.length > 0 ? stitchBeef(page) : undefined,
        totalOutputs: fixtures.length
      }
    })

    await expect(getVaultBalance(wallet, ADMIN)).resolves.toBe(
      fixtures.reduce((sum, fixture) => sum + fixture.satoshis, 0)
    )
    expect(wallet.listOutputs.mock.calls.map(([args]) => args.offset)).toEqual([0, 64])
  }, 120_000)

  it('rejects a wallet output response larger than the requested page before parsing its BEEF', async () => {
    await seedMeta()
    wallet.listOutputs.mockResolvedValue({
      outputs: Array.from({ length: 65 }, (_, index) => ({
        outpoint: `${index.toString(16).padStart(64, '0')}.0`,
        satoshis: 100_000
      }))
    })
    await expect(getVaultBalance(wallet, ADMIN)).rejects.toMatchObject({ code: 'no-transaction' })
  })

  it('fails closed when pagination makes zero progress before its reported total', async () => {
    await seedMeta()
    wallet.listOutputs.mockResolvedValue({ outputs: [], totalOutputs: 1 })
    await expect(getVaultBalance(wallet, ADMIN)).rejects.toMatchObject({ code: 'no-transaction' })
  })

  it('fails the whole scan on malformed recovery metadata instead of hiding funds', async () => {
    const fixture = vaultFixture(100_000, [PUB_A, PUB_B])
    await seedVault([fixture])
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [{ outpoint: fixture.outpoint, satoshis: fixture.satoshis, customInstructions: '{' }],
      BEEF: stitchBeef([fixture])
    })
    await expect(getVaultBalance(wallet, ADMIN)).rejects.toMatchObject({ code: 'template-invalid' })
  })

  it('fails closed on unsafe or negative listed values before summing', async () => {
    const fixture = vaultFixture(100_000, [PUB_A, PUB_B])
    await seedVault([fixture])
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [{ outpoint: fixture.outpoint, satoshis: -1, customInstructions: fixture.customInstructions }],
      BEEF: stitchBeef([fixture])
    })
    await expect(getVaultBalance(wallet, ADMIN)).rejects.toMatchObject({ code: 'no-transaction' })
  })
})
