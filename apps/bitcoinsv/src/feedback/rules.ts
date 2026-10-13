// When to ask "Enjoying Bitcoin SV Wallet?" (the prototype's requestFeedback
// in lib/stores/wallet-store.ts): at a calm moment, once someone has used the
// app a little, and not again for a while. Pure, so it can be tested anywhere.
//
// The prototype asks at most once a day, which it calls demo-friendly; a real
// app waits weeks between asks, and longer once someone has rated it or told
// the team what's wrong.

export type FeedbackReason = 'payment' | 'visits'

export interface FeedbackState {
  /** the last time the card was shown */
  lastAskedAt: string | null
  /** payments sent from this phone */
  paymentsSent: number
  /** times the app was opened */
  appOpens: number
  /** "I love it", and on to the store's rating */
  lovedAt?: string | null
  /** a note sent to the team */
  sentAt?: string | null
}

export const NO_FEEDBACK: FeedbackState = { lastAskedAt: null, paymentsSent: 0, appOpens: 0 }

const DAY = 24 * 60 * 60 * 1000

export const FEEDBACK_RULES = {
  /** after a payment: once at least this many have gone out */
  minPayments: 2,
  /** on Home: once the app has been opened this often */
  minOpens: 5,
  /** between one ask and the next */
  cooldownMs: 30 * DAY,
  /** after "I love it": they've been to the store */
  afterLovedMs: 120 * DAY,
  /** after they've told the team what's wrong */
  afterSentMs: 60 * DAY
}

const since = (at: string | null | undefined, now: number) => (at ? now - Date.parse(at) : Infinity)

/** Whether this is a good moment to ask. */
export function shouldAsk(state: FeedbackState, reason: FeedbackReason, now: number = Date.now()): boolean {
  if (since(state.lastAskedAt, now) < FEEDBACK_RULES.cooldownMs) return false
  if (since(state.lovedAt, now) < FEEDBACK_RULES.afterLovedMs) return false
  if (since(state.sentAt, now) < FEEDBACK_RULES.afterSentMs) return false
  if (reason === 'payment') return state.paymentsSent >= FEEDBACK_RULES.minPayments
  return state.appOpens >= FEEDBACK_RULES.minOpens
}
