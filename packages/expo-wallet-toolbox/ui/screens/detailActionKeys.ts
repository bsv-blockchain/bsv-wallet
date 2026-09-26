/**
 * Which detail-sheet action chips apply to an activity row.
 *
 * Extracted out of WalletHomeScreen's `detailActions()` (a pure decision, no
 * JSX or translated labels) so the parked/abort guard is unit-testable
 * without mounting the whole screen. See ActivityRow's `canAbort`, which
 * already carries this same `!parked` guard for the expanded-row surface —
 * this is the detail-sheet surface's copy of that decision.
 */

/**
 * Statuses whose transaction is still local and therefore abortable — the same
 * set `ActivityRow` gates its own Cancel chip on. Duplicated as a constant
 * rather than imported so the row keeps owning its own copy while both
 * surfaces exist.
 */
export const ABORTABLE_DETAIL_STATUSES = new Set(['unsigned', 'nosend', 'nonfinal', 'failed'])

export type DetailActionKey = 'refresh' | 'explorer' | 'abort' | 'cancel-parked' | 'request-confirmation'

/** Labels of the outgoing rails whose payment can be re-delivered over the
 * message box (the same set ActivityRow's `resendableOutbound` uses). */
const REDELIVERABLE_LABELS = new Set(['peerpay', 'localpay', 'mandala'])

export function detailActionKeysFor(args: {
  txid?: string
  reference?: string
  status: string
  offlineStatus?: string
  isOutgoing?: boolean
  labels?: string[]
}): DetailActionKey[] {
  const { txid, reference, status, offlineStatus, isOutgoing, labels } = args
  const parked = offlineStatus === 'parked'
  const out: DetailActionKey[] = []
  if (txid && !parked && offlineStatus !== 'queued' && offlineStatus !== 'posting') out.push('refresh')
  if (txid && !parked) out.push('explorer')
  // XR-095: a parked nearby payment's inputs may already be a payee's to
  // broadcast (FIX F) — cancelling it must always go through
  // `cancelParkedPayment`'s chain-status gate, never this unconditional
  // abort. Mirrors the `!parked` guard already used above for
  // 'refresh'/'explorer', and the one `ActivityRow`'s `canAbort` already has.
  //
  // 2026-09-25: and never on a payment this device recorded handing over
  // (queued, posting, sent, acknowledged, rejected, import_hold): the payee may
  // hold it, and an abort would free inputs their copy spends. Plain abort is
  // for a payment with no offline record at all — one that provably never
  // left the device.
  if (reference && offlineStatus === undefined && ABORTABLE_DETAIL_STATUSES.has(status)) out.push('abort')
  if (parked && txid) out.push('cancel-parked')
  // Re-deliver the same payment over the message box, whatever rail it first
  // took (the owner's "request confirmation from recipient").
  if (txid && isOutgoing === true && !!labels?.some(l => REDELIVERABLE_LABELS.has(l))) out.push('request-confirmation')
  return out
}
