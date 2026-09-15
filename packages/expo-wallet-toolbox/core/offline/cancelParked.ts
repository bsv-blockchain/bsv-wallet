/**
 * Cancel a parked nearby payment: one that was built, shown as a QR code, and
 * deliberately never released for broadcast.
 *
 * Parked is the honest state after the payer leaves the code screen without
 * confirming the hand-over: we cannot see whether the other phone scanned the
 * frame, so the transaction stays `nosend` and its inputs stay reserved. This
 * is the exit from that state for the "they never got it" case — abort the
 * action so the coins come back, and retire the offline row.
 *
 * Refuses once the transaction has left `nosend`. If it has been promoted, the
 * counterparty did broadcast (or is about to), and releasing the inputs would
 * hand the payer a double-spend against the person they just paid.
 */

import { updateOfflineAction } from '../storage/methods/offlineActions'
import { devLog } from '../logging'
import { getOnline } from '../net/online'
import type { FetchAdmissionFn, SettlementStore } from '../mandala/types'
import type { MandalaRuntime } from '../mandala/runtime'

const CANCELLABLE = new Set(['nosend', 'unsigned', 'unprocessed'])

export type CancelParkedOutcome = 'cancelled' | 'already-sent' | 'not-found'

export interface CancelParkedStorage {
  readonly sqliteDb: unknown
  findTransactions(args: {
    partial: { txid: string }
    noRawTx?: boolean
  }): Promise<{ reference?: string; status?: string }[]>
}

export interface CancelParkedWallet {
  abortAction(args: { reference: string }, originator?: string): Promise<{ aborted?: boolean } | void>
}

/**
 * FIX J: what makes a cancel overlay-authoritative for a token payment.
 *
 * Omit it entirely — every BSV caller does — and the cancel behaves exactly as
 * it always has. There is deliberately no "cancel by respend" path:
 * `token_settlements` has no `cancelling` state, so the only exits from
 * `handed_over`/`held` are the overlay's own eventual terminal verdict or this
 * check of a payment it never admitted.
 */
export interface CancelParkedSettlementDeps {
  settlements: Pick<SettlementStore, 'getSettlement'>
  /**
   * GET /admin/admission/:txid.
   *
   * The URL this is called with is ADVISORY. The row's `overlayUrl` is
   * re-derived from frames a counterparty wrote, so the runtime's
   * implementation pins every request to its own configured overlay and
   * verifies the answer against its own configured key (§9.10) — which is what
   * stops a payer naming a server that would happily "admit" their own
   * payment and talk this cancel out of releasing the coins.
   */
  fetchAdmission: FetchAdmissionFn
  /** Offline there is nothing to poll, so the local check stands alone. */
  isOnline: () => Promise<boolean>
}

/**
 * Assembles `CancelParkedSettlementDeps` from the Mandala runtime, for a
 * cancel call site: `mandala.store` already satisfies the read-only
 * `settlements` slice, and `mandala.fetchAdmission` is FIX-H-verified and
 * scoped to this session's overlay identity key. Returns `undefined` when
 * Mandala is unavailable — passing that straight through as `settlement`
 * leaves `cancelParkedPayment` exactly as it behaves for a plain BSV payment
 * (the local `nosend` check stands alone).
 */
export function mandalaSettlementDeps(
  mandala: Pick<MandalaRuntime, 'available' | 'store' | 'fetchAdmission'> | undefined,
  isOnline: () => Promise<boolean> = getOnline
): CancelParkedSettlementDeps | undefined {
  if (!mandala?.available) return undefined
  return { settlements: mandala.store, fetchAdmission: mandala.fetchAdmission, isOnline }
}

export async function cancelParkedPayment(args: {
  storage: CancelParkedStorage
  wallet: CancelParkedWallet
  originator?: string
  txid: string
  /** Token settlement. Absent for a plain BSV payment. */
  settlement?: CancelParkedSettlementDeps
}): Promise<CancelParkedOutcome> {
  const { storage, wallet, originator, txid, settlement } = args
  const db = storage.sqliteDb
  if (!db) throw new Error('the database is not open, cannot cancel this payment')

  const tx = (await storage.findTransactions({ partial: { txid }, noRawTx: true }))[0]
  if (!tx) return 'not-found'

  // FIX J. Locally this transaction still looks cancellable — it is `nosend`
  // and its inputs are still reserved — but for a token payment the overlay,
  // not this device, decides. The counterparty's own submit may already have
  // landed (rule 3: the RECIPIENT settles the hop), in which case aborting
  // would release inputs the overlay has already marked spent and hand the
  // payer a double-spend against the person they just paid.
  if (settlement && (await isOnline(settlement))) {
    const row = await settlement.settlements.getSettlement(txid)
    if (row) {
      const verdict = await fetchAdmissionSafely(settlement, row.overlayUrl, txid)
      if (verdict?.kind === 'admitted') return 'already-sent'
    }
  }

  if (!tx.status || !CANCELLABLE.has(tx.status)) return 'already-sent'
  if (!tx.reference) return 'not-found'

  const r = await wallet.abortAction({ reference: tx.reference }, originator)
  if (r && r.aborted === false) throw new Error('the wallet refused to cancel this payment')

  // Only after the abort landed: a retained parked row is recoverable, a
  // retired row over a live reservation is not.
  await updateOfflineAction(db as never, txid, { status: 'acknowledged' })
  return 'cancelled'
}

/**
 * A probe that throws must not strand the user on a screen they cannot leave.
 * Treating the failure as offline falls back to the local `nosend` check, which
 * is the behaviour every build before this feature had.
 */
async function isOnline(deps: CancelParkedSettlementDeps): Promise<boolean> {
  try {
    return await deps.isOnline()
  } catch (e) {
    devLog('[cancelParkedPayment] connectivity probe failed, treating as offline:', e)
    return false
  }
}

/**
 * Only a 200/admitted refuses the cancel. Anything else — a 404 for a txid the
 * overlay has never seen, a persisted refusal, an unreachable overlay — leaves
 * the decision to the local check: the payment was not admitted, so cancelling
 * it cannot double-spend anyone.
 */
async function fetchAdmissionSafely(deps: CancelParkedSettlementDeps, overlayUrl: string, txid: string) {
  try {
    return await deps.fetchAdmission(overlayUrl, txid)
  } catch (e) {
    devLog(`[cancelParkedPayment] could not reach ${overlayUrl} for ${txid}, falling back to the local check:`, e)
    return undefined
  }
}
