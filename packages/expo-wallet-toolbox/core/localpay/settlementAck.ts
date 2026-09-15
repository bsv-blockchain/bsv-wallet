/**
 * The settlement ack (offline-settlement spec §4.8, rule 5).
 *
 * When the recipient's drain gets σ_I for the tip, it tells the payer — so the
 * payer's screen can say "settled" instead of "settling", and its own
 * reconciliation pass can stop chasing a transaction that is already admitted.
 *
 * No new channel is introduced. The payload rides the string slot the existing
 * confirm channel already has (`confirmFrame(accepted, reason)` →
 * `Ack.error`), behind a prefix so it can never be mistaken for a
 * `DeclineReason`; over the handle rail it rides the `'mandala-payments'`
 * MessageBox instead. Same bytes either way.
 *
 * FIX H is the whole reason this module has a verification step at all. The
 * payload is COUNTERPARTY-SUPPLIED: it arrives from the other device, which
 * may be lying, broken, or replaying. So:
 *
 *   · it is verified against THIS session's overlay key before it is allowed
 *     to mean anything;
 *   · a payload that fails verification is treated as ABSENT — never as a
 *     decline, never as proof. The drain then runs its own `postTokenStep` as
 *     if no ack had arrived, which is exactly what it would do for a payer
 *     whose counterparty said nothing at all.
 *
 * That asymmetry is deliberate: a forged ack can only ever cost the payer a
 * redundant idempotent `/submit`, whereas treating a forged ack as a decline
 * would let any counterparty unwind a payment it had already accepted.
 */
import type { AdmissionEntryWire } from '../mandala/types'
import type { Ack } from './types'

/** Distinguishes a settlement payload from a `DeclineReason` in the same slot. */
export const SETTLEMENT_ACK_PREFIX = 'msa1:'

/** What the recipient tells the payer once the overlay has admitted the tip. */
export interface SettlementAck {
  txid: string
  /** Sorted ascending, exactly as the overlay signed them. */
  outputsToAdmit: number[]
  /** σ_I over `admissionDigestV2(txid, outputsToAdmit)`, DER hex. */
  admissionSignature: string
}

/**
 * Verifies one admission entry against the overlay that is supposed to have
 * signed it. Injected: the σ_I digest is the overlay's own and lives in
 * `@bsv/mandala`, so wallet and overlay cannot disagree about what is signed.
 */
export type VerifyAdmissionFn = (
  entry: AdmissionEntryWire,
  overlayIdentityKey: string
) => boolean | Promise<boolean>

export function encodeSettlementAck(ack: SettlementAck): string {
  return SETTLEMENT_ACK_PREFIX + JSON.stringify(ack)
}

/**
 * Reads a settlement payload out of the confirm channel's string slot.
 *
 * Returns undefined for anything that is not one — including a plain decline
 * code, an empty string, and a payload whose shape is wrong. Never throws: this
 * runs on bytes a counterparty chose, on a path where an exception would
 * abort a screen that has already taken real money.
 */
export function decodeSettlementAck(raw: unknown): SettlementAck | undefined {
  if (typeof raw !== 'string' || !raw.startsWith(SETTLEMENT_ACK_PREFIX)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(SETTLEMENT_ACK_PREFIX.length))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { txid, outputsToAdmit, admissionSignature } = parsed as Record<string, unknown>
  if (typeof txid !== 'string' || txid.length !== 64 || !/^[0-9a-f]+$/i.test(txid)) return undefined
  if (typeof admissionSignature !== 'string' || admissionSignature.length === 0) return undefined
  if (admissionSignature.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(admissionSignature)) return undefined
  if (!Array.isArray(outputsToAdmit)) return undefined
  const outs: number[] = []
  for (const v of outputsToAdmit) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return undefined
    outs.push(v)
  }
  return { txid: txid.toLowerCase(), outputsToAdmit: outs, admissionSignature: admissionSignature.toLowerCase() }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * The admission a positive ack carries, IF it carries one that verifies.
 *
 * Undefined means "no evidence arrived", for every reason there is: a decline,
 * an ordinary positive ack with nothing on it, a malformed payload, a payload
 * signed by somebody other than this session's overlay, a verifier that said
 * no, or a verifier that threw. The caller's next move is the same in all of
 * them — let the drain do its own submit — which is why they collapse to one
 * value rather than a taxonomy nobody would branch on.
 *
 * `expectTxid` binds the payload to the transaction actually handed over: an
 * ack naming a DIFFERENT txid is somebody else's admission, replayed. It
 * verifies perfectly and proves nothing about this payment.
 */
export async function readSettlementAck(
  ack: Ack,
  args: { overlayIdentityKey: string; expectTxid?: string; verify: VerifyAdmissionFn }
): Promise<AdmissionEntryWire | undefined> {
  if (!ack.ok) return undefined
  const payload = decodeSettlementAck(ack.error)
  if (!payload) return undefined
  if (args.expectTxid !== undefined && payload.txid !== args.expectTxid.toLowerCase()) return undefined

  const entry: AdmissionEntryWire = {
    txid: payload.txid,
    outputsToAdmit: payload.outputsToAdmit,
    signature: hexToBytes(payload.admissionSignature),
    signerKey: args.overlayIdentityKey
  }
  try {
    return (await args.verify(entry, args.overlayIdentityKey)) ? entry : undefined
  } catch {
    return undefined
  }
}

/**
 * What the payer's success screen says after a token hand-over (spec §9 step 7).
 *
 * Only two states, because guard #1 means a token `finalizeDelivery` ALWAYS
 * returns `broadcast: 'pending'` — there is no third, greener outcome it could
 * report on its own. The difference is whether a verified σ_I for this
 * transaction has come back yet:
 *
 *   'sent-settling' → "Sent. Settling with {{issuer}} — you'll see it confirm
 *                      once you or {{payee}} reconnect."
 *   'sent-settled'  → "Sent · settled with {{issuer}}"
 *
 * Takes the already-VERIFIED admission, not a raw ack, so a screen cannot turn
 * green on a payload nobody checked.
 */
export type TokenSendState = 'sent-settling' | 'sent-settled'

export function tokenSendState(admission?: AdmissionEntryWire): TokenSendState {
  return admission ? 'sent-settled' : 'sent-settling'
}
