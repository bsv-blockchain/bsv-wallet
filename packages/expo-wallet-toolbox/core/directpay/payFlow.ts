/**
 * Paying a wallet identity: live (direct) first, the message box second. The user never picks
 * a route; when the live attempt stopped before anything was made (a {@link NotSentError}
 * whose dial failed because the recipient is offline, not receiving, or the link did not come
 * up), the caller asks before sending it to their message box instead. One payment is always
 * one transaction: a failure after the payment was made is never offered the fallback, since
 * that would build a second one (the caller keeps it saved to retry). That failure says the
 * payment may have been sent (`spent: 'maybe'`), so the user does not pay again by hand.
 *
 * Pure: both routes are functions the caller passes in, and every word for the user comes back
 * as an i18n key.
 */
import type { DialFailure, DirectPayMessage, FallbackReason, PayFailure, PayOutcome } from './types'

/**
 * A payment that stopped before anything was made or broadcast, so nothing was spent (and,
 * for a dial that failed, the message box fallback may be offered). Either route throws this,
 * and only this, for every failure it can promise left no payment behind; any other error
 * from it is taken to mean the payment may have been delivered.
 *
 * `failure` is why the dial failed (see `dialFailure`), and is for the live route; without it
 * the payment stopped for some other reason, and `message` and `detail` are the reason, in
 * English, for the log.
 */
export class NotSentError extends Error {
  constructor(
    message: string,
    readonly detail = '',
    readonly failure?: DialFailure
  ) {
    super(message)
    this.name = 'NotSentError'
  }
}

const messageOf = (error: unknown) => (error instanceof Error && error.message) || ''

const failed = (
  spent: PayFailure['spent'],
  key: DirectPayMessage['key'],
  params?: DirectPayMessage['params'],
  detail?: string
): PayFailure => ({
  kind: 'failed',
  spent,
  key,
  ...(params && { params }),
  ...(detail && { detail })
})

/**
 * A stop that is no dial failure. Only a {@link NotSentError} proves nothing was spent; any
 * other error may come after the payment was made, so it says the payment may have been sent.
 */
function stopped(error: unknown, name: string): PayFailure {
  if (error instanceof NotSentError) {
    return failed('no', 'direct_pay_failed_not_sent', undefined, error.detail || error.message)
  }
  return failed('maybe', 'direct_pay_failed_maybe_sent', { name }, messageOf(error))
}

/**
 * Runs `direct` when given, else `messageBox`. A direct attempt that could not reach the
 * recipient asks for the message box fallback when `messageBox` is given; the caller runs it
 * after the user agrees (call again without `direct`). Either route throws a
 * {@link NotSentError} when it stopped before making the payment.
 */
export async function payIdentity(o: {
  direct?: () => Promise<{ ackStatus: string }>
  messageBox?: () => Promise<void>
  /** Who is being paid, as the user knows them: a name, a handle or a short key. */
  name: string
}): Promise<PayOutcome> {
  if (o.direct) {
    try {
      const { ackStatus } = await o.direct()
      return { kind: 'paid_live', ackStatus }
    } catch (error) {
      // Anything but a NotSentError may have reached the recipient: never offer a second payment.
      if (!(error instanceof NotSentError)) return stopped(error, o.name)
      switch (error.failure) {
        case 'offline':
        case 'rejected':
          if (o.messageBox) return { kind: 'ask_fallback', reason: 'offline' }
          return failed('no', 'direct_pay_failed_offline', { name: o.name })
        case 'timeout':
        case 'unknown':
          if (o.messageBox) return { kind: 'ask_fallback', reason: 'link_failed' }
          return failed('no', 'direct_pay_failed_link', { name: o.name })
        case 'too_large':
          // Released before anything was spent: the message box carries any size.
          if (o.messageBox) return { kind: 'ask_fallback', reason: 'too_large' }
          return stopped(error, o.name)
        case 'unavailable':
          return failed('no', 'direct_pay_failed_network')
        case 'wrong_network':
          return failed('no', 'direct_pay_failed_wrong_network', { name: o.name })
        case 'aborted':
          // The user cancelled: not a reason to offer anything else.
          return failed('no', 'direct_pay_failed_cancelled')
        default:
          return stopped(error, o.name)
      }
    }
  }
  if (!o.messageBox) return failed('no', 'direct_pay_failed_no_message_box')
  try {
    await o.messageBox()
    return { kind: 'paid_messagebox' }
  } catch (error) {
    return stopped(error, o.name)
  }
}

/** The fallback prompt for `reason`, naming the recipient. */
export function fallbackPrompt(reason: FallbackReason, name: string): Required<DirectPayMessage> {
  return {
    key:
      reason === 'offline'
        ? 'direct_pay_fallback_offline'
        : reason === 'too_large'
          ? 'direct_pay_fallback_too_large'
          : 'direct_pay_fallback_link_failed',
    params: { name }
  }
}
