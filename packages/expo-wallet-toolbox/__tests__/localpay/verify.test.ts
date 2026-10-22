/**
 * What a delivered frame actually pays this device.
 *
 * The figure a payee renders as a receipt has to come from the transaction
 * `internalizeAction` will credit, and is only worth reading once that output
 * is shown to lock to a key this device derives. These tests pin both halves,
 * and in particular the two holes the module closes: correct derivation
 * nonces with an output paying somebody else (ownership), and a properly-
 * addressed output backed by a transaction that never actually moved that
 * value (SPV/script/value conservation — P0-1).
 */
import {
  Beef,
  Hash,
  LockingScript,
  MerklePath,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Transaction,
  UnlockingScript,
  Utils,
  type ChainTracker,
  type WalletProtocol
} from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { ATTESTED_PROFILE_ID, colorProtocolID } from '@bsv/mandala'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'
import {
  FrameVerifyError,
  declineReasonFor,
  verifyFramePayment,
  type FrameVerifyDeps
} from '../../core/localpay/verify'
import { PEERPAY_PROTOCOL_ID } from '../../core/localpay/pending'
import type { PaymentFrame } from '../../core/localpay/codec'
import { buildColorModule } from '../../core/mandala/colorModule'
import { txHasColorOutput } from '../../core/mandala/colorGuard'
import { openTestDb } from '../__helpers__/nodeSqlite'

const payeeKey = PrivateKey.fromRandom().toPublicKey()
const senderIdentityKey = '02' + 'ab'.repeat(32)

/** The script a correct payer produces for this payee and these nonces. */
function minesScript(): string {
  return new P2PKH().lock(payeeKey.toAddress()).toHex()
}

/** A real AtomicBEEF carrying `outputs`, in order, with NO inputs.
 *
 * Fine for every check that runs before the SPV/script verifier (ownership,
 * amount, token decode) — none of those read the input side. Not usable as a
 * frame that must reach `tx.verify()` and succeed: an input-less transaction
 * is refused as unmined-with-no-inputs by the SDK's own structural check.
 */
function beefOf(outputs: { satoshis: number; scriptHex: string }[]): Uint8Array {
  const tx = new Transaction()
  for (const o of outputs) {
    tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.scriptHex) })
  }
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
}

function frameFor(transaction: Uint8Array, outputIndex = 0): PaymentFrame {
  return {
    version: 1,
    kind: 'bsv' as const,
    senderIdentityKey,
    amount: 0, // still on the type at this task; unread by verify
    outputIndex,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    transaction
  } as PaymentFrame
}

/** A payee whose wallet derives exactly one key, and records how it was asked.
 *
 * The chain tracker is unused by every check that runs before the SPV/script
 * verifier, so it only needs to be real for the tests that reach it — a
 * caller that reaches it without one gets a TypeError, not a false pass.
 */
function payeeDeps(chainTracker?: ChainTracker) {
  return {
    wallet: { getPublicKey: jest.fn(async () => ({ publicKey: payeeKey.toString() })) },
    chainTracker: chainTracker as ChainTracker
  }
}

// ── fixtures for the SPV/script verifier (P0-1) ──
//
// A mined ancestor is one whose OWN scripts are never checked by `tx.verify`
// — only its merkle path is (`Transaction_completeVerificationFromMerklePath`)
// — so its input can be any placeholder. What has to be real is the CHILD's
// spend of it: `tx.verify` runs the actual P2PKH script check on that input
// against the ancestor's real locking script.
const ANCESTOR_HEIGHT = 0

/** A "mined" ancestor paying `payerKey`, with a single-leaf merkle path whose
 * root is the ancestor's own txid (`MerklePath.computeRoot` for a lone leaf).
 */
function minedAncestor(payerKey: PrivateKey, satoshis: number): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
  tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(payerKey.toAddress()) })
  tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(tx.id('hex'), ANCESTOR_HEIGHT)
  return tx
}

/** The chain tracker a payee with this exact ancestor synced would report:
 * accepts only that ancestor's real root at its real height, current enough
 * to clear `MerklePath.verify`'s 100-block rule for the index-0 leaf.
 */
function trackerAccepting(ancestor: Transaction): ChainTracker {
  const root = (ancestor.merklePath as MerklePath).computeRoot(ancestor.id('hex'))
  return {
    isValidRootForHeight: async (r: string, h: number) => r === root && h === ANCESTOR_HEIGHT,
    currentHeight: async () => ANCESTOR_HEIGHT + 100
  }
}

/** A tracker that recognises no root at all — stands in for a payee whose
 * offline header window never covers this ancestor's height.
 */
function trackerRejectingEverything(): ChainTracker {
  return {
    isValidRootForHeight: async () => false,
    currentHeight: async () => ANCESTOR_HEIGHT + 100
  }
}

/** A properly-signed spend of `ancestor`'s output 0, paying `outputs` in order. */
async function spendAncestor(
  ancestor: Transaction,
  payerKey: PrivateKey,
  outputs: { satoshis: number; scriptHex: string }[]
): Promise<Transaction> {
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: ancestor,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(payerKey)
  })
  for (const o of outputs) tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.scriptHex) })
  await tx.sign()
  return tx
}

/** The AtomicBEEF for `tx`, including its ancestor graph and any merkle-path bumps. */
function atomicBeefOf(tx: Transaction): Uint8Array {
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
}

/** Same, but with `ancestorId` reduced to a bare txid (no raw bytes) — a
 * mined ancestor the payer's BEEF proved only by merkle path, never included
 * in full, so its script cannot actually be checked.
 */
function atomicBeefWithTxidOnlyAncestor(tx: Transaction, ancestorId: string): Uint8Array {
  const beef = new Beef()
  beef.mergeTransaction(tx)
  beef.makeTxidOnly(ancestorId)
  return new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
}

/** One end-to-end valid BSV frame: a real payer key, a mined ancestor of
 * `ancestorSatoshis`, and a proper P2PKH spend paying `outputs` to this
 * device (plus whatever else the caller adds). Returns the frame and the
 * wallet whose chain tracker will accept it.
 */
async function validFrame(
  outputs: { satoshis: number; scriptHex: string }[],
  opts?: { ancestorSatoshis?: number; outputIndex?: number }
): Promise<{ frame: PaymentFrame; deps: ReturnType<typeof payeeDeps>; ancestor: Transaction }> {
  const payerKey = PrivateKey.fromRandom()
  const ancestorSatoshis = opts?.ancestorSatoshis ?? outputs.reduce((s, o) => s + o.satoshis, 0)
  const ancestor = minedAncestor(payerKey, ancestorSatoshis)
  const tx = await spendAncestor(ancestor, payerKey, outputs)
  const frame = frameFor(atomicBeefOf(tx), opts?.outputIndex ?? 0)
  const deps = payeeDeps(trackerAccepting(ancestor))
  return { frame, deps, ancestor }
}

describe('verifyFramePayment', () => {
  it('returns the satoshis of the output that locks to this device’s derived key', async () => {
    const { frame, deps } = await validFrame([{ satoshis: 4200, scriptHex: minesScript() }])
    await expect(verifyFramePayment(deps, frame, 'admin.com')).resolves.toEqual({ kind: 'bsv', satoshis: 4200 })
  })

  it('derives with the payee’s own key, keyed by the frame’s nonces and the sender', async () => {
    const { frame, deps } = await validFrame([{ satoshis: 1, scriptHex: minesScript() }])
    await verifyFramePayment(deps, frame, 'admin.com')
    expect(deps.wallet.getPublicKey).toHaveBeenCalledWith(
      {
        protocolID: PEERPAY_PROTOCOL_ID,
        keyID: 'cHJlZml4 c3VmZml4',
        counterparty: senderIdentityKey,
        forSelf: true
      },
      'admin.com'
    )
  })

  it('reads the output named by outputIndex, not the first one', async () => {
    const { frame, deps } = await validFrame(
      [
        { satoshis: 9, scriptHex: '76a914' + '00'.repeat(20) + '88ac' },
        { satoshis: 777, scriptHex: minesScript() }
      ],
      { outputIndex: 1 }
    )
    await expect(verifyFramePayment(deps, frame, 'admin.com')).resolves.toEqual({
      kind: 'bsv',
      satoshis: 777
    })
  })

  // The hole this module closes: correct nonces, an output paying someone else.
  // Accepting it acks ok, the payer broadcasts, and the payee is credited nothing.
  it('refuses an output that pays a stranger', async () => {
    const transaction = beefOf([{ satoshis: 4200, scriptHex: '76a914' + '11'.repeat(20) + '88ac' }])
    await expect(verifyFramePayment(payeeDeps(), frameFor(transaction), 'admin.com')).rejects.toMatchObject({
      name: 'FrameVerifyError',
      kind: 'not_mine'
    })
  })

  it('refuses a zero-satoshi output', async () => {
    const transaction = beefOf([{ satoshis: 0, scriptHex: minesScript() }])
    await expect(verifyFramePayment(payeeDeps(), frameFor(transaction), 'admin.com')).rejects.toMatchObject({
      kind: 'not_mine'
    })
  })

  // `satoshis` is optional on the SDK's output type but mandatory in anything
  // that serializes, so a real AtomicBEEF cannot carry an absent value — the
  // guard is against the type, and this is the only way to reach it.
  it('refuses an output whose satoshis are absent', async () => {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 4200, lockingScript: LockingScript.fromHex(minesScript()) })
    tx.outputs[0].satoshis = undefined
    const spy = jest.spyOn(Transaction, 'fromAtomicBEEF').mockReturnValue(tx)
    try {
      await expect(verifyFramePayment(payeeDeps(), frameFor(new Uint8Array([1])), 'admin.com')).rejects.toMatchObject({
        kind: 'not_mine'
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('treats unreadable transaction bytes as a decode failure, not a mismatch', async () => {
    const frame = frameFor(new Uint8Array([1, 2, 3, 4, 5]))
    await expect(verifyFramePayment(payeeDeps(), frame, 'admin.com')).rejects.toMatchObject({
      kind: 'unparseable'
    })
  })

  it('treats an outputIndex past the end as a decode failure', async () => {
    const frame = frameFor(beefOf([{ satoshis: 4200, scriptHex: minesScript() }]), 3)
    await expect(verifyFramePayment(payeeDeps(), frame, 'admin.com')).rejects.toMatchObject({
      kind: 'unparseable'
    })
  })

  it('surfaces a wallet that cannot derive as an error, never as a pass', async () => {
    const w = { getPublicKey: jest.fn(async () => Promise.reject(new Error('locked'))) }
    await expect(
      verifyFramePayment(
        { wallet: w, chainTracker: trackerRejectingEverything() },
        frameFor(beefOf([{ satoshis: 1, scriptHex: minesScript() }])),
        'admin.com'
      )
    ).rejects.toThrow('locked')
  })

  it('is a FrameVerifyError, so callers can switch on kind', async () => {
    const err = await verifyFramePayment(payeeDeps(), frameFor(new Uint8Array([0])), 'admin.com').catch(e => e)
    expect(err).toBeInstanceOf(FrameVerifyError)
  })

  // The broadcast hold (`colorHeldTxids`) holds any tx with a 1Color output
  // until its `color_transfers` row reads `settled`, and only token transfers
  // ever get a row. A payer who adds a decoy 1Color output to an otherwise
  // valid BSV frame would have the payee's internalize parked for good: never
  // broadcast, while the payer stays free to double-spend the inputs. The BSV
  // rail refuses such a frame before anything is queued, by the very
  // predicate the hold uses.
  it('refuses a BSV frame whose transaction also carries a 1Color output', async () => {
    const decoy = new OneColor()
      .lock(`${'cd'.repeat(32)}_0`, 1n, PrivateKey.fromRandom().toPublicKey().toHash() as number[])
      .toHex()
    const { frame, deps } = await validFrame([
      { satoshis: 4200, scriptHex: minesScript() },
      { satoshis: 1, scriptHex: decoy }
    ])
    // The same tx is one the hold would park: the two predicates are one.
    expect(txHasColorOutput(Transaction.fromAtomicBEEF(Array.from(frame.transaction)).toBinary())).toBe(true)
    await expect(verifyFramePayment(deps, frame, 'admin.com')).rejects.toMatchObject({
      name: 'FrameVerifyError',
      kind: 'not_mine'
    })
    // Refused before the ownership derivation: nothing about it is ours to read.
    expect(deps.wallet.getPublicKey).not.toHaveBeenCalled()
    expect(declineReasonFor('not_mine')).toBe('session_mismatch')
  })

  it('refuses a BSV frame whose named output is itself a 1Color output', async () => {
    const pkh = payeeKey.toHash() as number[]
    const { frame, deps } = await validFrame([
      { satoshis: 1, scriptHex: new OneColor().lock(`${'cd'.repeat(32)}_0`, 5n, pkh).toHex() }
    ])
    await expect(verifyFramePayment(deps, frame, 'admin.com')).rejects.toMatchObject({ kind: 'not_mine' })
  })
})

// ── P0-1: the SPV/script/value-conservation gate ──
//
// Ownership and amount are cheap and certain, but say nothing about the rest
// of the transaction. `internalizeAction`'s own gate (toolbox
// `validateAtomicBeef` -> SDK `Beef.verify`) never runs a script interpreter
// and never checks sum(inputs) >= sum(outputs), so without this module's own
// `tx.verify(chainTracker)` call a payer could spend a real mined UTXO it
// does not own — with a garbage unlockingScript, or a script that pays out
// more than it took in — into an output that locks to this device, and be
// credited for it while offline.
describe('verifyFramePayment: SPV/script verification (P0-1)', () => {
  it('still verifies a valid frame end to end (regression)', async () => {
    const { frame, deps } = await validFrame([{ satoshis: 4200, scriptHex: minesScript() }])
    await expect(verifyFramePayment(deps, frame, 'admin.com')).resolves.toEqual({ kind: 'bsv', satoshis: 4200 })
  })

  // The hole this call closes: a real mined ancestor, a properly-addressed
  // and properly-valued output, but nothing actually unlocking the ancestor's
  // coin. Accepting it would credit the payee from a transaction that could
  // never be broadcast to move real money.
  it('rejects a garbage/empty unlockingScript before any settle-path write', async () => {
    const payerKey = PrivateKey.fromRandom()
    const ancestor = minedAncestor(payerKey, 4200)
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: ancestor, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
    tx.addOutput({ satoshis: 4200, lockingScript: LockingScript.fromHex(minesScript()) })

    const frame = frameFor(atomicBeefOf(tx))
    const deps = payeeDeps(trackerAccepting(ancestor))

    // Mimics the caller's shape (NearbyFlow's settleReceived): the settle-path
    // write only ever runs AFTER verifyFramePayment resolves. If verification
    // itself is broken, this mock proves the settle path was never reached.
    const settleWrite = jest.fn()
    const settleLikeCaller = async () => {
      const verified = await verifyFramePayment(deps, frame, 'admin.com')
      settleWrite()
      return verified
    }

    await expect(settleLikeCaller()).rejects.toMatchObject({ name: 'FrameVerifyError', kind: 'unparseable' })
    expect(settleWrite).not.toHaveBeenCalled()
  })

  // The other half of the same hole: a validly-signed spend, but one that
  // claims to pay out more than its ancestor actually held.
  it('rejects a transaction whose outputs exceed its inputs', async () => {
    const payerKey = PrivateKey.fromRandom()
    const ancestor = minedAncestor(payerKey, 4200)
    const tx = await spendAncestor(ancestor, payerKey, [{ satoshis: 5000, scriptHex: minesScript() }])

    const frame = frameFor(atomicBeefOf(tx))
    const deps = payeeDeps(trackerAccepting(ancestor))

    await expect(verifyFramePayment(deps, frame, 'admin.com')).rejects.toMatchObject({
      name: 'FrameVerifyError',
      kind: 'unparseable'
    })
  })

  // A mined ancestor the payer's BEEF proved only by merkle path, never
  // included as raw bytes: `tx.verify` cannot check a script it cannot read,
  // and MUST fail closed (refuse) rather than silently skip that input.
  it('rejects an ancestor present only as a txid, with no raw bytes to verify', async () => {
    const payerKey = PrivateKey.fromRandom()
    const ancestor = minedAncestor(payerKey, 4200)
    const tx = await spendAncestor(ancestor, payerKey, [{ satoshis: 4200, scriptHex: minesScript() }])

    const frame = frameFor(atomicBeefWithTxidOnlyAncestor(tx, ancestor.id('hex')))
    const deps = payeeDeps(trackerAccepting(ancestor))

    await expect(verifyFramePayment(deps, frame, 'admin.com')).rejects.toMatchObject({
      name: 'FrameVerifyError',
      kind: 'unparseable'
    })
  })

  // The ancestor's merkle root does not match what this payee's own chain
  // tracker (e.g. a stale offline header cache) reports for that height.
  it('rejects an ancestor whose merkle root the chain tracker does not accept', async () => {
    const payerKey = PrivateKey.fromRandom()
    const ancestor = minedAncestor(payerKey, 4200)
    const tx = await spendAncestor(ancestor, payerKey, [{ satoshis: 4200, scriptHex: minesScript() }])

    const frame = frameFor(atomicBeefOf(tx))
    const deps = payeeDeps(trackerRejectingEverything())

    await expect(verifyFramePayment(deps, frame, 'admin.com')).rejects.toMatchObject({
      name: 'FrameVerifyError',
      kind: 'root_unverified'
    })
  })
})

// ── the token path: 1Color under the BRC-207 `p color` derivation ──
//
// The payee is a REAL WalletPermissionsManager over a ProtoWallet with the
// color module registered, the way WalletContext publishes it, so the
// `getPublicKey` that proves "pays us" goes through the module's own key-arg
// check (ColorPermissionModule handleRequest, 0207:597) rather than a stub.
// The payer derives the payee's child exactly as lib `sendHandover` does:
// `colorProtocolID(assetId, prefix, suffix)`, keyID 'color', counterparty B.

const ASSET_ID = 'ab'.repeat(32) + '_0'
const OTHER_ASSET_ID = 'cd'.repeat(32) + '_0'
const ADMIN = 'admin.example'
const PAYEE_PRIV = new PrivateKey(31)
const PAYER_PRIV = new PrivateKey(32)
const PAYEE_IDENTITY = PAYEE_PRIV.toPublicKey().toString()
const PAYER_IDENTITY = PAYER_PRIV.toPublicKey().toString()
const PREFIX = 'cHJlZml4cHJlZml4cHJlZg=='
const SUFFIX = 'c3VmZml4c3VmZml4c3VmZg=='
const EP = {
  overlayUrl: 'https://overlay.example',
  overlayIdentityKey: new PrivateKey(9).toPublicKey().toString(),
  messageBoxUrl: 'https://messagebox.example'
}
const LEAF = { declarationTx: '00', transactions: [], attestations: [], submissions: [] }
const profileDataOf = (v: unknown): string => JSON.stringify(v)
const ATTESTED_ONLY = profileDataOf({ [ATTESTED_PROFILE_ID]: { [ASSET_ID]: LEAF } })

/** The payee's child key as the payer derives it (lib `sendHandover`, unblinded). */
async function payeeChildFromPayer(assetId = ASSET_ID, recipient = PAYEE_IDENTITY): Promise<string> {
  const payer = new ProtoWallet(PAYER_PRIV)
  const { publicKey } = await payer.getPublicKey({
    protocolID: colorProtocolID(assetId, PREFIX, SUFFIX) as WalletProtocol,
    keyID: 'color',
    counterparty: recipient
  })
  return publicKey
}

const pkhOf = (pub: string): number[] => Hash.hash160(Utils.toArray(pub, 'hex'))

function oneColorScript(amount: bigint, pkh: number[], assetId: string | null = ASSET_ID): string {
  return new OneColor().lock(assetId, amount, pkh).toHex()
}

function tokenFrame(transaction: Uint8Array, overrides: Partial<PaymentFrame> = {}): PaymentFrame {
  return {
    version: 6,
    kind: 'token',
    senderIdentityKey: PAYER_IDENTITY,
    outputIndex: 0,
    derivationPrefix: PREFIX,
    derivationSuffix: SUFFIX,
    token: { assetId: ASSET_ID, certificates: [], profileData: ATTESTED_ONLY },
    transaction,
    ...overrides
  }
}

/** A frame whose output 0 pays the payee `amount` of `assetId`. */
async function payingFrame(amount: bigint, assetId = ASSET_ID): Promise<PaymentFrame> {
  const pkh = pkhOf(await payeeChildFromPayer(assetId))
  return tokenFrame(beefOf([{ satoshis: 1, scriptHex: oneColorScript(amount, pkh, assetId) }]))
}

let raw: { close(): void } | undefined
const disposers: (() => void)[] = []
afterEach(() => {
  while (disposers.length > 0) disposers.pop()!()
  raw?.close()
  raw = undefined
})

/** The payee's published manager with the color module registered. */
async function payeeManager() {
  const db = await openTestDb()
  raw = db.raw
  const underlying = new ProtoWallet(PAYEE_PRIV)
  const underlyingGetPublicKey = jest.spyOn(underlying, 'getPublicKey')
  const built = buildColorModule({
    wallet: underlying as never,
    endpoints: EP,
    kv: db.kv,
    requestTokenAccess: async () => true,
    fetch: (async () => {
      throw new Error('verify must not contact the overlay')
    }) as unknown as typeof fetch
  })
  disposers.push(() => built.module.dispose())
  const moduleRequest = jest.spyOn(built.module, 'handleRequest')
  const manager = new WalletPermissionsManager(underlying as never, ADMIN, {
    permissionModules: { color: built.module }
  } as never)
  return {
    deps: { wallet: manager as unknown as FrameVerifyDeps['wallet'], chainTracker: trackerRejectingEverything() },
    moduleRequest,
    underlyingGetPublicKey
  }
}

describe('verifyFramePayment: token kind', () => {
  it('verifies a token frame that pays us under the p color derivation', async () => {
    const { deps, underlyingGetPublicKey } = await payeeManager()
    const frame = await payingFrame(1500n)

    await expect(verifyFramePayment(deps, frame, ADMIN, { assetId: ASSET_ID })).resolves.toEqual({
      kind: 'token',
      assetId: ASSET_ID,
      units: 1500n
    })
    // The derivation the module's receipt check will make: `p color`, keyID
    // 'color', the frame's sender as counterparty, for this device.
    expect(underlyingGetPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolID: colorProtocolID(ASSET_ID, PREFIX, SUFFIX),
        keyID: 'color',
        counterparty: PAYER_IDENTITY,
        forSelf: true
      }),
      ADMIN
    )
  })

  it('routes the p color derivation through the registered module for an app originator', async () => {
    const { deps, moduleRequest } = await payeeManager()
    const frame = await payingFrame(1500n)
    // An app originator is P-routed to the module, which passes getPublicKey
    // through after validating the key args (no consent prompt, no overlay).
    await expect(verifyFramePayment(deps, frame, 'app.example', { assetId: ASSET_ID })).resolves.toMatchObject({
      units: 1500n
    })
    expect(moduleRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'getPublicKey' }),
      expect.any(Function)
    )
  })

  it('refuses a frame paying another key, another asset, or carrying a non-attested profileData', async () => {
    const { deps } = await payeeManager()

    // Another key: the payer derived a child of somebody else.
    const strangerPkh = pkhOf(await payeeChildFromPayer(ASSET_ID, new PrivateKey(77).toPublicKey().toString()))
    const toStranger = tokenFrame(beefOf([{ satoshis: 1, scriptHex: oneColorScript(1500n, strangerPkh) }]))
    await expect(verifyFramePayment(deps, toStranger, ADMIN, { assetId: ASSET_ID })).rejects.toMatchObject({
      name: 'FrameVerifyError',
      kind: 'not_mine'
    })

    // Another asset: the script moves OTHER while the frame and session name ASSET.
    const otherAsset = await payingFrame(1500n, OTHER_ASSET_ID)
    await expect(verifyFramePayment(deps, otherAsset, ADMIN, { assetId: ASSET_ID })).rejects.toMatchObject({
      kind: 'not_mine'
    })
    // ...and a frame that names the asset its script moves, against a session for another one.
    const named = { ...otherAsset, token: { ...otherAsset.token!, assetId: OTHER_ASSET_ID } }
    await expect(verifyFramePayment(deps, named, ADMIN, { assetId: ASSET_ID })).rejects.toMatchObject({
      kind: 'not_mine'
    })

    // A non-attested profileData: empty, a second profile, a non-object leaf.
    const good = await payingFrame(1500n)
    for (const profileData of [
      profileDataOf({}),
      profileDataOf({ [ATTESTED_PROFILE_ID]: { [ASSET_ID]: LEAF }, 'https://brc.dev/207/other': {} }),
      profileDataOf({ 'https://brc.dev/207/other': { [ASSET_ID]: LEAF } }),
      profileDataOf({ [ATTESTED_PROFILE_ID]: { [OTHER_ASSET_ID]: LEAF } }),
      profileDataOf({ [ATTESTED_PROFILE_ID]: { [ASSET_ID]: [LEAF] } }),
      profileDataOf({ [ATTESTED_PROFILE_ID]: [] })
    ]) {
      const frame = { ...good, token: { ...good.token!, profileData } }
      await expect(verifyFramePayment(deps, frame, ADMIN, { assetId: ASSET_ID })).rejects.toMatchObject({
        kind: 'not_covered'
      })
    }
  })

  it('refuses a token frame verified against no session asset', async () => {
    const { deps } = await payeeManager()
    await expect(verifyFramePayment(deps, await payingFrame(1500n), ADMIN)).rejects.toMatchObject({
      kind: 'not_mine'
    })
  })

  it('reads units above 2^53 from the script exactly', async () => {
    const { deps } = await payeeManager()
    const frame = await payingFrame(9007199254740993n)
    await expect(verifyFramePayment(deps, frame, ADMIN, { assetId: ASSET_ID })).resolves.toEqual({
      kind: 'token',
      assetId: ASSET_ID,
      units: 9007199254740993n
    })
    const max = await payingFrame(18446744073709551615n)
    await expect(verifyFramePayment(deps, max, ADMIN, { assetId: ASSET_ID })).resolves.toMatchObject({
      units: 18446744073709551615n
    })
  })

  it('refuses a non-token script, a deploy and a missing token block', async () => {
    const { deps } = await payeeManager()
    const pkh = pkhOf(await payeeChildFromPayer())
    const p2pkh = tokenFrame(beefOf([{ satoshis: 1, scriptHex: new P2PKH().lock(pkh).toHex() }]))
    await expect(verifyFramePayment(deps, p2pkh, ADMIN, { assetId: ASSET_ID })).rejects.toMatchObject({
      kind: 'not_mine'
    })
    const deploy = tokenFrame(beefOf([{ satoshis: 1, scriptHex: oneColorScript(1000n, pkh, null) }]))
    await expect(verifyFramePayment(deps, deploy, ADMIN, { assetId: ASSET_ID })).rejects.toMatchObject({
      kind: 'not_mine'
    })
    const blockless = { ...(await payingFrame(1500n)), token: undefined }
    await expect(verifyFramePayment(deps, blockless, ADMIN, { assetId: ASSET_ID })).rejects.toMatchObject({
      kind: 'unparseable'
    })
  })

  it('reads the output named by outputIndex', async () => {
    const { deps } = await payeeManager()
    const pkh = pkhOf(await payeeChildFromPayer())
    const frame = tokenFrame(
      beefOf([
        { satoshis: 1, scriptHex: oneColorScript(5n, pkhOf(new PrivateKey(78).toPublicKey().toString())) },
        { satoshis: 1, scriptHex: oneColorScript(1500n, pkh) }
      ]),
      { outputIndex: 1 }
    )
    await expect(verifyFramePayment(deps, frame, ADMIN, { assetId: ASSET_ID })).resolves.toMatchObject({
      units: 1500n
    })
  })

  it('leaves the BSV path untouched by the session asset option', async () => {
    const { frame, deps } = await validFrame([{ satoshis: 4200, scriptHex: minesScript() }])
    await expect(verifyFramePayment(deps, frame, 'test', { assetId: ASSET_ID })).resolves.toEqual({
      kind: 'bsv',
      satoshis: 4200
    })
  })
})

describe('declineReasonFor', () => {
  // The payer renders these in ITS locale, so the wire carries a stable machine
  // code. Every one of them must mean the payee queued nothing.
  it('maps each verify failure to the decline the payer can act on', () => {
    expect(declineReasonFor('unparseable')).toBe('decode_failed')
    expect(declineReasonFor('not_mine')).toBe('session_mismatch')
    expect(declineReasonFor('not_covered')).toBe('not_covered')
    expect(declineReasonFor('root_unverified')).toBe('root_unverified')
  })

  it('falls back to decode_failed for anything it does not recognise', () => {
    expect(declineReasonFor('something else' as never)).toBe('decode_failed')
  })
})
