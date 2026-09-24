import { Hash, P2PKH, PublicKey, Transaction, Utils } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import type { PaymentFrame } from './codec'
import { coverFromFrame, type CoverVerifier } from '../mandala/bundle'
import { PEERPAY_PROTOCOL_ID } from './pending'
import { isRequestableAmount } from './session'
import type { DeclineReason } from './types'

// mandala's FT derivation protocol — the payer locks token outputs under it
// with OUR payee-minted nonces as keyID, preserving the frame-to-session binding
export const FT_PROTOCOL_ID: [2, string] = [2, 'mandala token']

export type VerifiedPayment =
  | { kind: 'bsv'; satoshis: number }
  | {
      kind: 'token'
      assetId: string
      amount: number
      /**
       * COVER's own answer: the chain transactions that still have to reach the
       * overlay, parents first, tip last. The payee is the party nominally
       * responsible for submitting them (settlement rule 3), so it is handed
       * the list it proved rather than recomputing it later from storage.
       */
      mustSubmit: string[]
    }

/**
 * Why a frame could not be shown to pay this device.
 *
 * Three kinds, because the payee's decline reason differs: bytes that are not a
 * transaction are a decode problem the payer can retry from; a transaction that
 * pays someone else is a frame that was never for us; and a token frame whose
 * evidence does not COVER its own ancestry is a frame that pays us with a coin
 * the issuer's overlay has never vouched for — retrying it will not help, and
 * the payer needs to hear which of the three it was.
 */
export type FrameVerifyKind = 'unparseable' | 'not_mine' | 'not_covered'

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

/** The one wallet capability this module needs: BRC-42 derivation. */
export interface DerivingWallet {
  getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }>
}

/**
 * The satoshis a delivered frame actually pays this device.
 *
 * `internalizeAction` credits the output, not any field beside it, so the
 * figure a payee renders as a receipt has to come from the transaction — and
 * is only worth reading once the output is shown to be ours. The derivation
 * below is the payee-side mirror of the payer's in `build.ts`: same protocol,
 * same keyID, same counterparty, `forSelf` flipped. If the script matches, the
 * output is spendable by this device and its satoshi count is the payment.
 *
 * Throws on every failure and returns on none, so a caller cannot mistake a
 * refusal for a zero-value payment. MUST be called before the settle path
 * latches or writes anything: every throw here has to remain an invariant
 * this module enforces on itself — a "queued nothing" decline, by construction.
 */
export async function verifyFramePayment(
  wallet: DerivingWallet,
  frame: PaymentFrame,
  originator: string,
  /**
   * Token frames only. `cover` is the pure COVER walk (spec §1.2), injected
   * because it lives in `@bsv/mandala` beside the overlay's own σ_I digest.
   *
   * Its ABSENCE refuses a token frame rather than crediting one: no verifier
   * is no evidence, and a caller that forgot to wire it must not get a credit
   * indistinguishable from a covered one. The BSV path never reads it.
   */
  opts?: {
    cover?: CoverVerifier
    /**
     * Token frames only. THIS DEVICE's configured facts about the asset it
     * agreed to be paid in — the session's own `asset` block, which the payee
     * minted and the payer echoed back, not anything read off the frame.
     *
     * Wire contract §9.10: the verifier's trust anchor comes from its own
     * configuration, and the bundle's `overlayIdentityKey` is DATA that must
     * EQUAL it. Without this comparison a frame names its own overlay, and
     * `coverFromFrame` — which builds the COVER bundle straight from
     * `frame.token.overlayIdentityKey` — would happily verify every σ_I in the
     * frame against a key the payer chose. A payer with any keypair could then
     * sign its own admissions and be credited for a coin no issuer ever saw.
     *
     * Its ABSENCE refuses a token frame, exactly as a missing `cover` does: no
     * configured asset is no anchor.
     */
    asset?: { overlayUrl: string; overlayIdentityKey: string }
  }
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

    return { kind: 'bsv', satoshis: output.satoshis }
  }

  if (!frame.token) throw new FrameVerifyError('unparseable', 'token frame without token block')

  let decoded: { assetId: string; amount: number; pubKeyHash: number[] }
  try {
    decoded = MandalaToken.decode(output.lockingScript)
  } catch (e) {
    throw new FrameVerifyError('not_mine', `the named output is not a token script: ${messageOf(e)}`)
  }
  if (decoded.assetId !== frame.token.assetId) {
    throw new FrameVerifyError('not_mine', 'the output moves a different asset than the frame declares')
  }
  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: FT_PROTOCOL_ID,
      keyID: `${frame.derivationPrefix} ${frame.derivationSuffix}`,
      counterparty: frame.senderIdentityKey,
      forSelf: true
    },
    originator
  )
  const expectedPkh = Hash.hash160(Utils.toArray(publicKey, 'hex'))
  const mine = decoded.pubKeyHash.length === expectedPkh.length &&
    decoded.pubKeyHash.every((b, i) => b === expectedPkh[i])
  if (!mine) throw new FrameVerifyError('not_mine', 'the named token output does not pay this device')
  if (!Number.isSafeInteger(decoded.amount) || decoded.amount < 1) {
    throw new FrameVerifyError('not_mine', `the named output carries no usable token amount: ${decoded.amount}`)
  }

  // Coverage runs LAST, and only for an output already proven to be ours.
  // Ownership is the cheaper, more certain check, and running a third party's
  // injected verifier over a stranger's frame would hand it bytes that were
  // never this device's business.
  //
  // This is the whole offline-settlement gate: the coin is credited — spendable
  // immediately, which is what makes chained offline re-spend work — the moment
  // every token ancestor bottoms out at a σ_I this device can verify against
  // THIS session's overlay key, or at bytes it can walk further. Anything else
  // is refused here, before the settle path latches or writes anything, so the
  // refusal stays an unlatched "queued nothing" by construction.
  if (!opts?.cover) {
    throw new FrameVerifyError('not_covered', 'no coverage verifier was supplied for a token frame')
  }

  // The trust anchor, BEFORE the walk (wire contract §9.10). `coverFromFrame`
  // takes the bundle's `overlayIdentityKey` from the frame, so this equality is
  // what makes that key the CONFIGURED one rather than the payer's choice —
  // and the overlay URL goes with it, because the linkage payloads this frame
  // carries are the bytes a later `/submit` is aimed at, and aiming them at an
  // attacker's overlay is how a wallet is talked into treating a stranger's
  // "admitted" as the issuer's.
  const asset = opts.asset
  if (!asset || !sameOverlay(frame.token, asset)) {
    throw new FrameVerifyError(
      'not_covered',
      `the frame’s admission evidence does not cover it: unsafe_asset`
    )
  }

  const covered = await coverFromFrame(frame, opts.cover)
  if (!covered.ok) {
    throw new FrameVerifyError('not_covered', `the frame’s admission evidence does not cover it: ${covered.reason}`)
  }

  return { kind: 'token', assetId: decoded.assetId, amount: decoded.amount, mustSubmit: covered.mustSubmit }
}

/**
 * Both overlay facts, compared the way each is actually written.
 *
 * The identity key is hex and case-insensitive — a frame writing it uppercase
 * is the same overlay and must not be refused. The URL is compared exactly
 * apart from a trailing slash: anything cleverer (host-only, scheme-agnostic)
 * would start accepting `http://` for `https://`, or a path under the
 * configured origin, which is precisely what this check exists to stop.
 */
function sameOverlay(
  token: { overlayUrl: string; overlayIdentityKey: string },
  asset: { overlayUrl: string; overlayIdentityKey: string }
): boolean {
  const url = (u: string) => u.trim().replace(/\/+$/, '')
  return (
    token.overlayIdentityKey.toLowerCase() === asset.overlayIdentityKey.toLowerCase() &&
    url(token.overlayUrl) === url(asset.overlayUrl)
  )
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
