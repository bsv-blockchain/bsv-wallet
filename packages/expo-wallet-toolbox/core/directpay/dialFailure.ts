/**
 * Classifies why dialing a recipient failed. Duck-typed on `name`, `code` and `reason`, so this
 * needs no import of `@bsv/webrtpay`, and an error that crossed a worker or bridge boundary
 * (own properties kept, prototype lost) is read the same.
 *
 * The codes are those `DirectPayClient.connect` rejects with:
 * `peer_unreachable` (no reply in the presence window, or the relay socket could not be
 * opened or closed on the dial), `rejected` (the recipient refused; `reason` is `busy`,
 * `not_receiving` or `wrong_network`, or whatever else it said), `unavailable` (the signaling
 * service could not do its part: the relay had no TURN credentials, or MessageBox could not
 * deliver the signal), `timeout` (it replied but the link did not come up), and `closed` (the
 * channel closed; `Dial cancelled` when the caller's signal aborted).
 *
 * Two things for the caller that dials. `peer_unreachable` is also what a payer with no
 * network on relay signaling gets, so check this wallet's own relay connection before taking
 * `offline` to mean the recipient is away. And a cancelled dial is told apart by that message
 * text alone (or an abort error): the dial's catch should check its own `signal.aborted` and
 * throw `NotSentError(..., 'aborted')` itself, so a reworded message cannot turn Cancel into
 * an offer to use the message box.
 */
import type { DialFailure } from './types'

interface DialError {
  name?: unknown
  code?: unknown
  reason?: unknown
  message?: unknown
}

/** The {@link DialFailure} for an error from a dial. */
export function dialFailure(error: unknown): DialFailure {
  if (typeof error !== 'object' || error === null) return 'unknown'
  const { name, code, reason, message } = error as DialError

  // A native or DOM abort, however the dial's caller cancelled it.
  if (name === 'AbortError' || code === 'ABORT_ERR') return 'aborted'
  if (name !== 'WebRTPayError') return 'unknown'

  switch (code) {
    case 'peer_unreachable':
      return 'offline'
    case 'unavailable':
      return 'unavailable'
    case 'timeout':
      return 'timeout'
    case 'rejected':
      if (reason === 'wrong_network') return 'wrong_network'
      if (reason === 'not_receiving' || reason === 'busy') return 'rejected'
      return 'unknown'
    case 'closed':
      // The package reports a cancelled dial as a closed one, worded "Dial cancelled".
      return typeof message === 'string' && /dial cancelled/i.test(message) ? 'aborted' : 'unknown'
    default:
      return 'unknown'
  }
}
