/**
 * The token half of a nearby (localpay) frame, as the v4 hand-over body the
 * lib reads, and how a failed receipt is classified (design §9 B7, IC §7.3).
 *
 * A FRAME_VERSION 7 token frame carries exactly the §7.2 body members (minus
 * `v`/`kind`, which the frame version replaces): the frame's own sender key,
 * remittance strings, output index, note and AtomicBEEF, plus the token
 * block's asset id, decimal amount, sender mode and the σ / envelope evidence.
 * The payee rebuilds the body here and runs the lib's own recipient path on it
 * (`parseHandoverBody` → `acceptHandover`: online submit or offline COVER,
 * host ledger record, then the plain BRC-207 receipt internalize). The
 * receipt itself is the 5-member custody JSON (IC §7.1); no evidence ever
 * travels in `customInstructions`.
 *
 * Pure: no wallet, no storage, no network.
 */
import { Utils } from '@bsv/sdk'
import { classifyReceiveError, type HandoverBodyV4, type HandoverResult } from '@bsv/mandala'
import type { PaymentFrame, TokenPayment } from '../localpay/codec'

/**
 * The v4 hand-over body a token frame stands for. Throws a TypeError for a
 * BSV frame (the codec refuses a token kind without its block; this is the
 * second wall). Members are copied verbatim: `parseHandoverBody` is the one
 * strict check, so this never "repairs" anything a sender put on the wire.
 */
export function bodyFromFrame(frame: PaymentFrame): HandoverBodyV4 {
  if (frame.kind !== 'token' || frame.token === undefined) {
    throw new TypeError('a v4 hand-over body is built from a token frame')
  }
  const t = frame.token
  return {
    v: 4,
    kind: 'handover',
    assetId: t.assetId,
    amount: t.amount,
    derivationPrefix: frame.derivationPrefix,
    derivationSuffix: frame.derivationSuffix,
    senderIdentityKey: frame.senderIdentityKey,
    senderMode: t.senderMode,
    transaction: Utils.toHex(Array.from(frame.transaction)),
    outputIndex: frame.outputIndex,
    ...(t.admission !== undefined ? { admission: t.admission } : {}),
    admissions: t.admissions,
    linkage: t.linkage,
    ...(frame.note !== undefined && frame.note !== '' ? { note: frame.note } : {})
  }
}

/** The frame's token block for a signed hand-over: the evidence members of its v4 body. */
export function tokenPaymentOfHandover(h: Pick<HandoverResult, 'body'>): TokenPayment {
  const b = h.body
  return {
    assetId: b.assetId,
    amount: b.amount,
    senderMode: b.senderMode,
    ...(b.admission !== undefined ? { admission: b.admission } : {}),
    admissions: b.admissions,
    linkage: b.linkage,
    certificates: []
  }
}

/** `(ERR_X)` or `(ERR_X, retryable)`, the lib/overlay message tag. */
const CODE_TAG = /\((ERR_[A-Z0-9_]+)(, retryable)?\)/

function nameOf(e: unknown): string {
  const n = (e as { name?: unknown } | null)?.name
  return typeof n === 'string' ? n : ''
}

function messageOf(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message
  return typeof m === 'string' ? m : String(e)
}

/**
 * Module refusals of the asset itself (its `req` names a profile this wallet
 * does not support, or no overlay is configured for its issuer key): final for
 * this wallet's configuration, whatever the lib's generic classifier says.
 */
const FINAL_MODULE_ERRORS = ['UnsupportedProfileError', 'ProfileParamsError'] as const

const isNamed = (e: unknown, name: string): boolean => nameOf(e) === name || messageOf(e).includes(`[${name}] `)

/**
 * Whether a failed receipt is worth retrying, by the lib's own receive
 * classifier (`classifyReceiveError`): `retry` (a transport fault, a
 * retryable verdict, `ERR_NOT_COVERED`, `ERR_BODY_UNREADABLE`, anything
 * unrecognised) is retriable; `ack` (a malformed or contradicting body, a
 * refused hop, a final overlay verdict, `ProfileDataError`) and `declined`
 * (the user's own "no") are final, and so are the module's refusals of the
 * asset itself (`FINAL_MODULE_ERRORS`). An unanswerable "is it final?" stays
 * retriable: a payment is never journaled refused on a guess.
 */
export function isRetriableReceiptFailure(e: unknown): boolean {
  if (FINAL_MODULE_ERRORS.some(n => isNamed(e, n))) return false
  return classifyReceiveError(e).disposition === 'retry'
}

/** True for a transport-level overlay failure (no typed verdict): the attempt is not counted. */
export function isTransportReceiptFailure(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  if (code === 'ERR_UNAVAILABLE') return true
  return CODE_TAG.exec(messageOf(e))?.[1] === 'ERR_UNAVAILABLE'
}

/**
 * The refusal code journaled for a failed receipt: the lib/overlay `ERR_*`
 * code when there is one, else the error class, else `ERR_RECEIPT`.
 */
export function receiptFailureCode(e: unknown): string {
  const c = classifyReceiveError(e)
  if (c.code !== undefined) return c.code
  if (c.disposition === 'declined') return 'ColorConsentDeclinedError'
  for (const n of FINAL_MODULE_ERRORS) if (isNamed(e, n)) return n
  const name = nameOf(e)
  if (name !== '' && name !== 'Error') return name
  const bracket = /^\[([A-Za-z]+Error)\] /.exec(messageOf(e))?.[1]
  return bracket ?? 'ERR_RECEIPT'
}
