import { Hash, P2PKH, PublicKey, Transaction, Utils } from '@bsv/sdk'
import type { ChainTracker, WalletProtocol } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { MAX_UINT64, colorProtocolID, cover, decodeToken, parseHandoverBody, verifyAttestation } from '@bsv/mandala'
import { bodyFromFrame } from '../mandala/receipt'
import type { PaymentFrame } from './codec'
import { PEERPAY_PROTOCOL_ID } from './pending'
import { isRequestableAmount } from './session'
import type { DeclineReason } from './types'

/** keyID of every `p color` derivation (0207:540-546), as lib `sendHandover` derives it. */
const COLOR_KEY_ID = 'color'

/**
 * What a verified frame pays this device: satoshis on the BSV path, exact
 * token base units (1..2^64-1, read from the script) on the token path.
 */
export type VerifiedPayment = { kind: 'bsv'; satoshis: number } | { kind: 'token'; assetId: string; units: bigint }

/**
 * Why a frame could not be shown to pay this device.
 *
 * Four kinds, because the payee's decline reason differs: bytes that are not a
 * transaction are a decode problem the payer can retry from; a transaction that
 * pays someone else (or another asset than the session's) is a frame that was
 * never for us; a token frame whose `profileData` is not the attested evidence
 * this wallet's module requires is a frame the issuer's evidence does not
 * cover — retrying it will not help; and a transaction whose ancestry ends at
 * a block root this device could not confirm, which is what an offline payee
 * with no header for that block sees. That last one is fixed by the PAYEE
 * getting online briefly, so the payer needs to hear which of the four it was.
 */
export type FrameVerifyKind = 'unparseable' | 'not_mine' | 'not_covered' | 'root_unverified'

/**
 * The decline code the payer is told, for each way verification can fail.
 *
 * One mapping, in one place, because it crosses the wire: the payee's screens
 * and the QR path both refuse frames, and two hand-written switches would drift
 * into telling the same payer two different stories about the same failure.
 * Every code here means the payee queued NOTHING, so the payer may safely
 * release the inputs its `noSend` action is holding.
 */
export function declineReasonFor(kind: FrameVerifyKind): DeclineReason {
  if (kind === 'not_mine') return 'session_mismatch'
  if (kind === 'not_covered') return 'not_covered'
  if (kind === 'root_unverified') return 'root_unverified'
  return 'decode_failed'
}

export class FrameVerifyError extends Error {
  readonly kind: FrameVerifyKind
  constructor(kind: FrameVerifyKind, message: string) {
    super(message)
    this.name = 'FrameVerifyError'
    this.kind = kind
  }
}

/** The one wallet capability this module needs: BRC-42 derivation. The
 * permissions manager satisfies it as is. */
export interface DerivingWallet {
  getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }>
}

/**
 * What `verifyFramePayment` needs from this device, as two separate
 * dependencies rather than one object that must happen to provide both: the
 * permissions manager derives keys but holds no chain services, and a single
 * "wallet" parameter asking for both is how a missing `getServices()` once
 * reached production as a TypeError on every Nearby BSV payment.
 */
export interface FrameVerifyDeps {
  wallet: DerivingWallet
  /**
   * The chain tracker the BSV branch's SPV check walks merkle paths against —
   * the same one `internalizeAction` consults, i.e.
   * `storage.getServices().getChainTracker()`. In the app that is the
   * offline-first tracker over the local header window, so an offline payee
   * can still verify. Not read for a token frame.
   */
  chainTracker: ChainTracker
}

/**
 * What a delivered frame actually pays this device: satoshis, or exact token
 * units.
 *
 * `internalizeAction` credits the output, not any field beside it, so the
 * figure a payee renders as a receipt has to come from the transaction — and
 * is only worth reading once the output is shown to be ours. Each derivation
 * below is the payee-side mirror of the payer's (PeerPay in `build.ts`, the
 * `p color` recipient key in lib `sendHandover`): same protocol, same keyID,
 * same counterparty, `forSelf` flipped. If the script matches, the output is
 * spendable by this device and its value is the payment.
 *
 * Throws on every failure and returns on none, so a caller cannot mistake a
 * refusal for a zero-value payment. MUST be called before the settle path
 * latches or writes anything: every throw here has to remain an invariant
 * this module enforces on itself — a "queued nothing" decline, by construction.
 */
export async function verifyFramePayment(
  { wallet, chainTracker }: FrameVerifyDeps,
  frame: PaymentFrame,
  originator: string,
  /**
   * Token frames only: THIS DEVICE's own session asset id, the asset the payee
   * asked to be paid in. The frame's `token.assetId` is data that must equal
   * it, and the script must move it. Its ABSENCE refuses a token frame: no
   * session asset is no binding. `overlayIdentityKey` is THIS DEVICE's
   * configured Mandala overlay key K: the evidence must reach σ by it.
   */
  opts?: { assetId?: string; overlayIdentityKey?: string }
): Promise<VerifiedPayment> {
  let tx: Transaction
  try {
    tx = Transaction.fromAtomicBEEF(frame.transaction)
  } catch (e) {
    throw new FrameVerifyError('unparseable', `frame transaction is not readable AtomicBEEF: ${messageOf(e)}`)
  }

  const output = tx.outputs[frame.outputIndex]
  if (!output) {
    throw new FrameVerifyError(
      'unparseable',
      `frame names outputIndex ${frame.outputIndex}, but the transaction has ${tx.outputs.length} outputs`
    )
  }

  if (frame.kind === 'bsv') {
    // A 1Color output elsewhere in the transaction is not refused here: the
    // broadcast hold applies only to transactions in which THIS wallet's
    // token custody is involved (its own `p color` inputs, or a receipt it
    // recorded in the host ledger or journal), so a payer's decoy 1Color
    // output cannot park this BSV credit (`colorGuard.ts`).
    const { publicKey } = await wallet.getPublicKey(
      {
        protocolID: PEERPAY_PROTOCOL_ID,
        keyID: `${frame.derivationPrefix} ${frame.derivationSuffix}`,
        counterparty: frame.senderIdentityKey,
        forSelf: true
      },
      originator
    )

    let expected: string
    try {
      expected = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
    } catch (e) {
      // The derived key is ours and should always parse; a failure here means we
      // cannot say the output is ours, which is the same refusal either way.
      throw new FrameVerifyError('not_mine', `could not derive this device’s expected script: ${messageOf(e)}`)
    }

    if (output.lockingScript.toHex() !== expected) {
      throw new FrameVerifyError('not_mine', 'the named output does not pay this device')
    }

    // Optional on the SDK type, and a zero or fractional value would render as a
    // receipt for money that never moved.
    if (!isRequestableAmount(output.satoshis)) {
      throw new FrameVerifyError('not_mine', `the named output carries no usable satoshi value: ${output.satoshis}`)
    }

    // The ownership/amount checks above are cheap and certain, but they say
    // nothing about the REST of the transaction: `internalizeAction`'s own
    // gate (toolbox `validateAtomicBeef` -> SDK `Beef.verify`) is a pure
    // AtomicBEEF-structure/SPV check with no script interpreter step, so
    // without this call a payer could spend a real mined UTXO it does not
    // own, with a garbage unlockingScript, into an output that locks to us,
    // for any amount, and have it accepted here.
    //
    // `tx.verify(chainTracker)` does the whole job in one pass: it walks
    // every ancestor's merkle path against this device's own offline-capable
    // chain tracker, runs the per-input script check against each ancestor's
    // real locking script (defeating the garbage-unlockingScript attack), and
    // checks sum(outputs) <= sum(inputs) (defeating an inflated-output
    // attack) — and it FAILS CLOSED: it throws when an input's ancestor is
    // present only as a txid (no raw bytes, e.g. a mined ancestor the payer's
    // BEEF only proved by merkle path) rather than silently skipping that
    // input, which is the desired refusal for an ancestor this device cannot
    // actually verify. No feeModel is passed, so a legitimate low-fee frame
    // is never refused on fee grounds — only on SPV/script/value grounds.
    //
    // The tracker is wrapped only to notice a refused merkle root, so that
    // refusal can be told apart from a bad script or value: `tx.verify`
    // returns false for both. A refused root is what an offline payee sees
    // for a block its header window does not reach yet (and what anyone sees
    // for a forged proof), and the remedy — the payee going online — is
    // different from a malformed transaction's.
    let rootRefused = false
    const observed: ChainTracker = {
      isValidRootForHeight: async (root, height) => {
        const ok = await chainTracker.isValidRootForHeight(root, height)
        if (!ok) rootRefused = true
        return ok
      },
      currentHeight: async () => await chainTracker.currentHeight()
    }
    // A refused root surfaces as a throw ("Invalid merkle path"), so both exits
    // check the flag.
    const rootUnverified = () =>
      new FrameVerifyError('root_unverified', 'a merkle root in the frame could not be confirmed on this device')
    let verified: boolean
    try {
      verified = await tx.verify(observed)
    } catch (e) {
      if (rootRefused) throw rootUnverified()
      throw new FrameVerifyError('unparseable', `transaction failed SPV/script verification: ${messageOf(e)}`)
    }
    if (!verified) {
      if (rootRefused) throw rootUnverified()
      throw new FrameVerifyError('unparseable', 'transaction failed SPV/script verification')
    }

    return { kind: 'bsv', satoshis: output.satoshis }
  }

  if (!frame.token) throw new FrameVerifyError('unparseable', 'token frame without token block')

  // What this function checks is the cheap, certain part that must decide the
  // payer's decline BEFORE the settle path latches or writes: the output is a
  // 1Color value output of the session's asset whose script amount is the
  // frame's, it pays a key this device derives, the v4 body the frame stands
  // for parses strictly, and its evidence reaches an admission by THIS
  // device's own overlay key (offline COVER, pure). The online submit, the
  // host-ledger record and the receipt internalize are the settle path's
  // (`nearby.accept`, design §9 B7).

  // (1) The named output is a 1Color VALUE output of the session's asset.
  const decoded = decodeToken(output.lockingScript, tx.id('hex'), frame.outputIndex)
  if (decoded === null || decoded.role !== 'value' || decoded.assetId === undefined) {
    throw new FrameVerifyError('not_mine', 'the named output is not a 1Color value output')
  }
  if (decoded.assetId !== frame.token.assetId) {
    throw new FrameVerifyError('not_mine', 'the output moves a different asset than the frame declares')
  }
  if (opts?.assetId === undefined || decoded.assetId !== opts.assetId) {
    throw new FrameVerifyError('not_mine', 'the output moves a different asset than this request asked for')
  }
  const units = decoded.amount
  if (typeof units !== 'bigint' || units < 1n || units > MAX_UINT64) {
    throw new FrameVerifyError('not_mine', `the named output carries no usable token amount: ${String(units)}`)
  }
  if (frame.token.amount !== units.toString()) {
    throw new FrameVerifyError('not_mine', 'the frame’s amount is not the named output’s')
  }

  // (2) It pays us: the payee-side mirror of lib `sendHandover`'s recipient
  //     derivation — `p color <assetTag> <prefix> <suffix>`, keyID 'color',
  //     the frame's sender (A, or A′ when blinded) as counterparty, forSelf.
  //     Through the PUBLISHED manager: the module passes getPublicKey through
  //     after checking the key args (0207:597). Remittance strings the lib
  //     refuses to name a protocol with cannot be ours either.
  let protocolID: [2, string]
  try {
    protocolID = colorProtocolID(decoded.assetId, frame.derivationPrefix, frame.derivationSuffix)
  } catch (e) {
    throw new FrameVerifyError('not_mine', `the frame’s remittance names no p color key: ${messageOf(e)}`)
  }
  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: protocolID as WalletProtocol,
      keyID: COLOR_KEY_ID,
      counterparty: frame.senderIdentityKey,
      forSelf: true
    },
    originator
  )
  let expected: string
  try {
    expected = new OneColor()
      .lock(decoded.assetId, units, Hash.hash160(Utils.toArray(publicKey, 'hex')))
      .toHex()
  } catch (e) {
    throw new FrameVerifyError('not_mine', `could not derive this device’s expected token script: ${messageOf(e)}`)
  }
  if (output.lockingScript.toHex() !== expected) {
    throw new FrameVerifyError('not_mine', 'the named token output does not pay this device')
  }

  // (3) The evidence: the v4 body parses strictly (exact members, σ and
  //     envelope row shapes), and either a σ by THIS device's configured K
  //     covers the named output of the tip itself, or COVER over the body
  //     reaches σ by K with every unanchored hop checked (S1) — the same two
  //     offline arms as the lib's `acceptHandover`. No K is no binding: the
  //     frame is refused.
  const K = opts?.overlayIdentityKey
  if (K === undefined || !/^0[23][0-9a-f]{64}$/.test(K)) {
    throw new FrameVerifyError('not_covered', 'this device has no Mandala overlay key to verify the evidence against')
  }
  let parsed: ReturnType<typeof parseHandoverBody>
  try {
    parsed = parseHandoverBody(bodyFromFrame(frame))
  } catch (e) {
    throw new FrameVerifyError('not_covered', `the frame’s hand-over evidence is malformed: ${messageOf(e)}`)
  }
  const tipTxid = tx.id('hex')
  const rows = [...(parsed.admission !== undefined ? [parsed.admission] : []), ...parsed.admissions]
  const tipCovered = rows.some(
    a => a.txid === tipTxid && a.outputs.includes(frame.outputIndex) && verifyAttestation(a, decoded.assetId as string, K)
  )
  if (tipCovered) return { kind: 'token', assetId: decoded.assetId, units }
  const admissions = new Map<string, (typeof parsed.admissions)[number]>()
  for (const a of rows) {
    if (!admissions.has(a.txid)) admissions.set(a.txid, a)
  }
  let covered: ReturnType<typeof cover>
  try {
    covered = cover({ assetId: decoded.assetId, tip: tx, admissions, linkage: parsed.linkage }, { expectedSignerKey: K })
  } catch (e) {
    throw new FrameVerifyError('not_covered', `the frame’s evidence could not be checked: ${messageOf(e)}`)
  }
  if (!covered.ok) {
    throw new FrameVerifyError(
      'not_covered',
      `the frame’s evidence does not reach an admission (${covered.reason}${covered.detail ? `: ${covered.detail}` : ''})`
    )
  }

  return { kind: 'token', assetId: decoded.assetId, units }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
