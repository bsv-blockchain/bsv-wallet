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
 *  2. A network failure is NOT a refusal. When the overlay could not be
 *     reached, it may have admitted the transaction and lost the response — so
 *     the copy claims nothing, does not invite a retry (a retry would build a
 *     second spend of the same coins and be refused for conservation forever),
 *     and offers "Check again" instead.
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

/** Everything that is not a refusal: unreachable, timeout, DNS, socket. */
export function tokenUnavailableCopy(message: string, ctx: TokenSendContext): TokenSendCopy {
  const values = { ticker: ctx.ticker, issuer: ctx.issuer || ctx.issuerFallback }
  const m = message.toLowerCase()
  // A funding throw is a local, provable fact and keeps its own sentence even
  // when it surfaces through the unavailable channel.
  if (has(m, 'fund', 'not enough satoshis')) return { key: 'pay_asset_needs_bsv', values, action: 'get-bsv' }
  if (has(m, 'busy', 'in flight')) return { key: 'token_err_busy', values }
  return { key: 'token_err_unreachable', values, action: 'check-again' }
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
