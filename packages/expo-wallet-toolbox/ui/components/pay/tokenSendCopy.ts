/**
 * What a failed token send SAYS — pure, so it can be argued about in a test
 * rather than on a phone.
 *
 * Two rules from the design decide every line here, and they are the reason
 * this is a lookup rather than a string concatenation at the call site:
 *
 *  1. The guarantee is separate from the guess. "Nothing was sent and your
 *     balance is unchanged" is attached ONLY to an explicit refusal, where the
 *     runtime has already aborted the action and the inputs are provably
 *     released. A narrowed reason on top of that ("…because it is paused") is a
 *     hint, and a wrong hint on a true guarantee is survivable.
 *  2. A LOCAL failure is not a refusal either, but since the hand-over-first
 *     decision it is the only non-refusal a send can have: nothing on this
 *     rail contacts the overlay, so there is no lost response to reconcile and
 *     no reason to hedge. That branch names the local reason and says plainly
 *     that nothing left the wallet — see `tokenUnavailableCopy`.
 *
 * When the issuer cannot be named, `{{issuer}}` becomes "the issuer" rather
 * than a key or a hex string: the overlay-unreachable case in particular must
 * not attribute an outage to a party that may not be the one that was down.
 */
import type { TokenSendResult } from '../../../core/mandala/runtime'

export interface TokenSendCopy {
  /** i18n key. */
  key: string
  /** Interpolation values; always carries `ticker` and `issuer`. */
  values: Record<string, string>
  /** The one inline affordance the note may carry. */
  action?: 'get-bsv' | 'check-again'
}

export interface TokenSendContext {
  ticker: string
  /** Already resolved to a name, or undefined when the issuer cannot be named. */
  issuer?: string
  /** The fallback noun for an unnamed issuer, translated by the caller. */
  issuerFallback: string
  /** The fallback phrase for a failure that came with no message, translated by the caller. */
  reasonFallback?: string
}

const has = (haystack: string, ...needles: string[]) => needles.some(n => haystack.includes(n))

/**
 * A refusal code or an error message, narrowed to the sentence the holder gets.
 * Matching is by substring because the code space spans two overlay engines and
 * the lib's own throws; an unmatched code lands on the plain refusal, which is
 * true for every one of them.
 */
export function tokenRefusalCopy(code: string, ctx: TokenSendContext): TokenSendCopy {
  const values = { ticker: ctx.ticker, issuer: ctx.issuer || ctx.issuerFallback }
  const c = code.toLowerCase()

  if (has(c, 'pause')) return { key: 'token_err_refused_paused', values }
  if (has(c, 'frozen', 'freeze', 'evicted')) return { key: 'token_err_refused_frozen', values }
  if (has(c, 'recipient', 'allowlist', 'not_allowed', 'blocked', 'registry', 'membership', 'sanction'))
    return { key: 'token_err_refused_recipient', values }
  if (has(c, 'insufficient')) return { key: 'token_err_balance_changed', values }
  if (has(c, 'busy', 'already in flight', 'in flight'))
    return { key: 'token_err_busy', values }
  if (has(c, 'fund', 'insufficient funds', 'not enough satoshis'))
    return { key: 'pay_asset_needs_bsv', values, action: 'get-bsv' }
  return { key: 'token_err_refused', values }
}

/**
 * Everything that is not a refusal.
 *
 * Since the 2026-09-15 hand-over-first decision (§4.5 / wire contract §9.13)
 * this branch no longer covers "the overlay could not be reached": SENDING
 * CONTACTS NO OVERLAY AT ALL, so the only ways a send can fail here are local
 * — the MessageBox would not open, the wallet could not build or sign, coin
 * selection came up short. Every one of those is provable and reversible on
 * this device, which changes the copy twice over:
 *
 *  · it may now promise "nothing left your wallet", because nothing did; and
 *  · it must NOT name the issuer, who was never involved and may be perfectly
 *    healthy — attributing a local fault to them is simply a lie.
 *
 * "Check again" goes with the old sentence for the same reason: there is no
 * lost response to reconcile, so there is nothing to check.
 */
export function tokenUnavailableCopy(message: string, ctx: TokenSendContext): TokenSendCopy {
  const values = { ticker: ctx.ticker, issuer: ctx.issuer || ctx.issuerFallback }
  const m = message.toLowerCase()
  // A funding throw is a local, provable fact and keeps its own sentence even
  // when it surfaces through the unavailable channel.
  if (has(m, 'fund', 'not enough satoshis')) return { key: 'pay_asset_needs_bsv', values, action: 'get-bsv' }
  if (has(m, 'busy', 'in flight')) return { key: 'token_err_busy', values }
  // `reasonFallback` is the caller's translated noun for "we have no detail";
  // an un-interpolated `{{reason}}` would read as a missing sentence.
  return {
    key: 'token_err_send_failed',
    values: { ...values, reason: message.trim() || ctx.reasonFallback || 'unknown error' }
  }
}

/** The runtime's own result, mapped to copy. `sent` has no copy — it succeeded. */
export function tokenSendCopy(result: TokenSendResult, ctx: TokenSendContext): TokenSendCopy | null {
  if (result.kind === 'sent') return null
  if (result.kind === 'refused') return tokenRefusalCopy(result.code || result.message || '', ctx)
  return tokenUnavailableCopy(result.message || '', ctx)
}

/** A thrown error from the send path, mapped the same way. */
export function tokenThrowCopy(error: unknown, ctx: TokenSendContext): TokenSendCopy {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const m = message.toLowerCase()
  // The one string the lib throws that IS a provable refusal: the facilitator
  // came back with zero admitted outputs and the action was aborted.
  if (has(m, 'overlay rejected')) return tokenRefusalCopy(message, ctx)
  if (has(m, 'insufficient token balance')) return tokenRefusalCopy('insufficient', ctx)
  return tokenUnavailableCopy(message, ctx)
}
