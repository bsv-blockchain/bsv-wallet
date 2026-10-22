/**
 * The PAYEE's half of a nearby token hand-over (plan 07 Task 16): the BRC-207
 * §7.1 receipt a v6 localpay frame carries, as `internalizeAction` takes it,
 * and how a failed receipt internalize is classified.
 *
 * The frame's fields are the receipt's, one to one (IC §7.3): the remittance
 * strings, the sender key (A, or A′ when the payer blinded) and the
 * `profileData` JSON the payer's module produced for this hand-over. Nothing
 * here verifies evidence; the color module does that inside
 * `internalizeAction`, against this device's own configured overlay, before
 * it credits anything (IC §2.2-5, 0207:299-357).
 *
 * Pure: no wallet, no storage, no network.
 */
import { ATTESTED_PROFILE_ID, colorBasket, type ReceiptInstruction } from '@bsv/mandala'
import type { PaymentFrame } from '../localpay/codec'

const HEX = /^(?:[0-9a-f]{2})+$/

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The §7.1 receipt of a token frame: `{version:1, assetId, derivationPrefix,
 * derivationSuffix, senderIdentityKey, profileData}`, in that member order.
 * Throws for a BSV frame or a `profileData` that is not a JSON object (the
 * codec refuses both at decode; this is the second wall, not the first).
 */
export function receiptFromFrame(frame: PaymentFrame): ReceiptInstruction {
  if (frame.kind !== 'token' || frame.token === undefined) {
    throw new TypeError('a §7.1 receipt is built from a token frame')
  }
  const profileData = JSON.parse(frame.token.profileData) as unknown
  if (!isPlainObject(profileData)) throw new TypeError('the frame’s profileData is not a JSON object')
  return {
    version: 1,
    assetId: frame.token.assetId,
    derivationPrefix: frame.derivationPrefix,
    derivationSuffix: frame.derivationSuffix,
    senderIdentityKey: frame.senderIdentityKey,
    profileData
  }
}

/**
 * The one `internalizeAction` output for a token frame: a basket insertion of
 * the named output into `p color <assetTag>` (lib `colorBasket`), carrying the
 * receipt verbatim. No caller tags: the module authors every `color_*` tag
 * and strips any a caller supplies (IC §2.2-6).
 */
export function receiptInternalizeOutput(frame: PaymentFrame): {
  outputIndex: number
  protocol: 'basket insertion'
  insertionRemittance: { basket: string; customInstructions: string }
} {
  const receipt = receiptFromFrame(frame)
  return {
    outputIndex: frame.outputIndex,
    protocol: 'basket insertion',
    insertionRemittance: { basket: colorBasket(receipt.assetId), customInstructions: JSON.stringify(receipt) }
  }
}

/**
 * The attested leaf's deploy tx for the receipt's own asset, when it is a
 * lowercase hex string; display data only (W7 metadata cache).
 */
export function declarationTxOf(receipt: ReceiptInstruction): string | undefined {
  const attested = receipt.profileData?.[ATTESTED_PROFILE_ID]
  const leaf = isPlainObject(attested) ? attested[receipt.assetId] : undefined
  const decl = isPlainObject(leaf) ? leaf.declarationTx : undefined
  return typeof decl === 'string' && HEX.test(decl) ? decl : undefined
}

/** Module error classes that are a definitive verdict on the receipt itself. */
const FINAL_NAMES = [
  'AttestationEvidenceError',
  'ProfileDataError',
  'ProfileParamsError',
  'UnsupportedProfileError',
  'ColorConsentDeclinedError'
] as const

/**
 * The module's consent-decline text (vendored dist:
 * `BRC-207: the user declined the ${requestType} request`). Matched as well as
 * the class, because a decline is final on the nearby rail (IC §7.2: no retry
 * channel) and its class name may not survive the manager stack.
 */
const DECLINED_TEXT = /BRC-207: the user declined the \S+ request/

/** `(ERR_X)` or `(ERR_X, retryable)`, the lib provider's message tag (G13). */
const CODE_TAG = /\((ERR_[A-Z0-9_]+)(, retryable)?\)/

interface ErrorFacts {
  name: string
  message: string
  code?: string
  retryable?: boolean
}

function factsOf(e: unknown): ErrorFacts {
  const o = (e !== null && typeof e === 'object' ? e : {}) as {
    name?: unknown
    message?: unknown
    code?: unknown
    retryable?: unknown
  }
  const name = typeof o.name === 'string' ? o.name : ''
  const message = typeof o.message === 'string' ? o.message : typeof e === 'string' ? e : ''
  const tag = CODE_TAG.exec(message)
  const code = typeof o.code === 'string' && /^ERR_[A-Z0-9_]+$/.test(o.code) ? o.code : tag?.[1]
  const retryable = typeof o.retryable === 'boolean' ? o.retryable : tag !== null ? tag[2] !== undefined : undefined
  return { name, message, ...(code !== undefined ? { code } : {}), ...(retryable !== undefined ? { retryable } : {}) }
}

/**
 * Names are matched on `.name` OR the module's `[Name] ` message prefix,
 * never `instanceof` (IC D22): a BRC-100 substrate may hand back a plain
 * Error with the class only in its text.
 */
const isNamed = (f: ErrorFacts, name: string): boolean => f.name === name || f.message.includes(`[${name}] `)

/**
 * Whether a failed receipt internalize is worth retrying.
 *
 * - `ColorProviderError`: its own `retryable` (property, else the `(ERR_X,
 *   retryable)` tag). Without either, retriable: an unanswerable "is it
 *   final?" must never journal a payment refused.
 * - `AttestationEvidenceError`, `ProfileDataError`, `ProfileParamsError`,
 *   `UnsupportedProfileError` and a consent decline: final.
 * - Anything else (a storage fault, a transport fault, a non-error): retriable.
 */
export function isRetriableReceiptFailure(e: unknown): boolean {
  const f = factsOf(e)
  if (isNamed(f, 'ColorProviderError')) return f.retryable !== false
  if (FINAL_NAMES.some(n => isNamed(f, n))) return false
  if (DECLINED_TEXT.test(f.message)) return false
  return true
}

/** True for a module/provider overlay verdict (`ColorProviderError`), by name or message prefix. */
export function isColorProviderError(e: unknown): boolean {
  return isNamed(factsOf(e), 'ColorProviderError')
}

/**
 * The refusal code journaled for a failed receipt: the overlay's `ERR_*`
 * code when there is one, else the module error class, else `ERR_RECEIPT`.
 */
export function receiptFailureCode(e: unknown): string {
  const f = factsOf(e)
  if (f.code !== undefined) return f.code
  for (const n of ['ColorProviderError', ...FINAL_NAMES]) if (isNamed(f, n)) return n
  if (DECLINED_TEXT.test(f.message)) return 'ColorConsentDeclinedError'
  return 'ERR_RECEIPT'
}
