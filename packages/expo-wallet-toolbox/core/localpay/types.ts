import type { PaymentFrame } from './codec'
import type { Session } from './session'

export interface Ack {
  ok: boolean
  error?: string
}

/**
 * Why a payee refused a delivered frame.
 *
 * A stable machine code, deliberately not display text: it crosses the wire in
 * `Ack.error` and is rendered on the PAYER's device, in the PAYER's locale.
 * Sending the payee's already-localized sentence would show a Japanese payer a
 * Polish error. The payer maps these to its own strings and falls back to
 * echoing anything it does not recognise.
 *
 * Every one of these means the payee queued NOTHING, so the payer may safely
 * release the inputs its `noSend` action is holding. Nothing that could leave
 * the payment half-committed may ever be reported as a decline.
 */
export type DeclineReason =
  /** The frame's derivation nonces or amount do not match the live request. */
  | 'session_mismatch'
  /** This one-shot session was already settled by an earlier delivery. */
  | 'already_paid'
  /** Storage was unavailable, busy, or the write failed. Retryable. */
  | 'save_failed'
  /** The frame did not decode — version skew, truncation, trailing bytes. */
  | 'decode_failed'
  /**
   * Token frames only: the frame's admission evidence does not COVER its own
   * ancestry (offline-settlement spec §1.2). Some token ancestor bottoms out
   * at neither a σ_I this device can verify against the session's overlay key
   * nor bytes it can walk further — so the coin being offered is one the
   * issuer's overlay has never vouched for.
   *
   * Distinct from `session_mismatch` because it is not retryable and not the
   * payer's mistake about WHICH request they are paying: the payer must get
   * their own chain admitted before this payment can be accepted by anyone.
   */
  | 'not_covered'

const DECLINE_REASONS: readonly string[] = [
  'session_mismatch',
  'already_paid',
  'save_failed',
  'decode_failed',
  'not_covered'
]

export function isDeclineReason(value: string): value is DeclineReason {
  return DECLINE_REASONS.includes(value)
}

/**
 * Acknowledges a delivered frame back to the payer.
 *
 * Call with `true` ONLY once the payment is durably persisted: a positive ack
 * is what releases the payer's transaction for broadcast, and it must never be
 * a claim that mere receipt has occurred. Call with `false` on every path that
 * queued nothing, so the payer learns immediately instead of resting on a
 * green "Sent".
 *
 * Idempotent, and never rejects — a failed ack is not a failed payment on the
 * payee's side, and must not be allowed to flip a settled screen.
 */
export type ConfirmDelivery = (accepted: boolean, reason?: DeclineReason) => Promise<void>

/** A frame that arrived, plus the handle that tells the payer what became of it. */
export interface ReceivedFrame {
  frame: PaymentFrame
  confirm: ConfirmDelivery
}

export interface LocalPaymentTransport {
  readonly kind: 'awdl' | 'nearby' | 'ble' | 'qr'
  receive(session: Session, signal: AbortSignal): Promise<ReceivedFrame>
  send(session: Session, frame: PaymentFrame, signal: AbortSignal): Promise<Ack>
}

export class QrHandoffRequired extends Error {
  constructor() {
    super('QR transport is driven by the UI, not by this interface')
    this.name = 'QrHandoffRequired'
  }
}

/** Thrown when an ack cannot be decoded or does not have the shape of a valid Ack. */
export class AckError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AckError'
  }
}
