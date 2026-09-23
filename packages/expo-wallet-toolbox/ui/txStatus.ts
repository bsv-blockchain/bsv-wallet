/**
 * Transaction status, collapsed into four tones for at-a-glance reading.
 *
 * The old list gave EVERY row a tinted pill, so a healthy wallet was a wall of
 * green and the one row that actually needed the user could not win attention.
 * Here the settled tone carries NO chroma at all: quiet text, no pill. Colour
 * is spent only where the user might have to act.
 *
 * Labels and translation keys are unchanged — this only changes how a status is
 * rendered, never what it is called.
 */

export type StatusTone = 'settled' | 'inflight' | 'attention' | 'failed'

export interface TxStatusView {
  /** i18n key for the human label. */
  key: string
  tone: StatusTone
}

/**
 * Map a raw action status (and any live offline-queue state) to a tone.
 *
 * The offline queue row outranks the raw status: a held transaction sits at
 * 'unproven' (which would read as a quiet "Pending") or at 'nosend' when
 * payer-side promotion failed, so without this the user would see a confirmed
 * payment that has not actually gone anywhere.
 */
/**
 * Labels the Pay / Get paid rails write on their actions: handle and nearby
 * payments, address payments, and stablecoin transfers. An outgoing action
 * without one was made by a connected app or the wallet itself (an identity
 * certificate, say), so it reads "Spent", not "Sent".
 */
const PAYMENT_LABELS = new Set(['peerpay', 'localpay', 'legacy', 'mandala'])

export function isPaymentAction(labels?: readonly string[]): boolean {
  return Boolean(labels?.some(l => PAYMENT_LABELS.has(l)))
}

/** What a row says it did once it settles. Its i18n key is `tx_status_<kind>`. */
export type ActivityKind = 'sent' | 'received' | 'spent' | 'transferred'

/**
 * The one place a row's word is decided, so the status line and the activity
 * filter can never disagree about which word a row says.
 */
export function activityKind(incoming: boolean | undefined, labels?: readonly string[]): ActivityKind {
  // A vault move stays the holder's money whichever way it goes.
  if (labels?.includes('vault')) return 'transferred'
  if (incoming) return 'received'
  return isPaymentAction(labels) ? 'sent' : 'spent'
}

export function txStatusView(
  status: string,
  offlineStatus?: string,
  incoming?: boolean,
  labels?: readonly string[]
): TxStatusView {
  const done = `tx_status_${activityKind(incoming, labels)}`

  switch (offlineStatus) {
    case 'queued':
      return { key: 'tx_status_offline_queued', tone: 'inflight' }
    case 'posting':
      return { key: 'tx_status_offline_sending', tone: 'inflight' }
    case 'rejected':
      return { key: 'tx_status_offline_rejected', tone: 'failed' }
    // Built and shown as a code, never released. The underlying status is
    // 'nosend' ("Not sent"), which is true but says nothing about why; this
    // says the payment is waiting on a hand-over that may not have happened.
    case 'parked':
      return { key: 'tx_status_parked', tone: 'attention' }
  }

  switch (status) {
    // The chain words ("Confirmed", "Accepted") answered a question about the
    // ledger; the user's question is what happened to their money. A settled
    // row therefore says what it DID — Received or Sent — from the moment it is
    // handed to the network: the block proof that follows changes nothing the
    // holder can act on. The states below that DO need action keep their own words.
    case 'completed':
    case 'unproven':
      return { key: done, tone: 'settled' }
    // Already handed to the network: say what it does, Sent or Received.
    case 'sending':
      return { key: done, tone: 'inflight' }
    case 'nosend':
      return { key: 'tx_status_not_sent', tone: 'attention' }
    case 'unsigned':
      return { key: 'tx_status_unsigned', tone: 'attention' }
    case 'nonfinal':
      return { key: 'tx_status_nonfinal', tone: 'attention' }
    case 'failed':
      return { key: 'tx_status_failed', tone: 'failed' }
    default:
      return { key: status, tone: 'settled' }
  }
}

/** Colour for a tone. `settled` deliberately returns the quiet text colour. */
export function toneColor(tone: StatusTone, colors: Record<string, string>): string {
  switch (tone) {
    case 'settled':
      return colors.textSecondary
    case 'inflight':
      return colors.info
    case 'attention':
      return colors.warning
    case 'failed':
      return colors.error
  }
}

/** Settled rows get no pill — only states the user might act on are boxed. */
export const tonePill = (tone: StatusTone): boolean => tone !== 'settled'
