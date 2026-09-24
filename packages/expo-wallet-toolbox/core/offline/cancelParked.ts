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

export type CancelParkedOutcome = 'cancelled' | 'already-sent' | 'not-found' | 'unverifiable-offline'

export interface CancelParkedStorage {
  readonly sqliteDb: unknown
  findTransactions(args: {
    partial: { txid: string }
    noRawTx?: boolean
  }): Promise<{ reference?: string; status?: string }[]>
  /**
   * Optional only so every existing test double (and the token-only overlay
   * path, which never needed it) keeps compiling; the real StorageExpoSQLite
   * always has it. Absent, or a services object with no `getStatusForTxids`,
   * is treated exactly like "the network doesn't know this txid" — see
   * `chainAlreadyKnows`.
   */
  getServices?(): {
    getStatusForTxids?: (txids: string[]) => Promise<{ results?: { txid: string; status: string }[] }>
  }
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
  /**
   * P1-3: the connectivity probe for the chain-status check below, independent
   * of `settlement` (which may be entirely absent on the BSV rail). Defaults
   * to the real probe; a failed probe is treated as online, not offline —
   * same direction as every other `getOnline` guard in this codebase
   * (build.ts's `finalizeDelivery`) — because the network call the "online"
   * branch makes fails harmlessly on its own if the device really has no
   * connection, and defaulting to "offline" here would instead start
   * blocking cancels on a transient probe hiccup.
   */
  isOnline?: () => Promise<boolean>
  /**
   * The payer has already been shown, and accepted, the "cannot verify this
   * payment while offline" warning (t('local_pay_cancel_unverifiable_title'
   * / '_body')) and still wants to cancel. Skips the offline refusal below;
   * never skips the online chain-status check itself.
   */
  acknowledgedUnverifiable?: boolean
}): Promise<CancelParkedOutcome> {
  const { storage, wallet, originator, txid, settlement, acknowledgedUnverifiable } = args
  const isOnlineProbe = args.isOnline ?? getOnline
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

  // P1-3-localpay-cancelparked-bsv: the check above is token-only (it is
  // skipped entirely for a plain BSV payment, or a token txid with no
  // settlement row yet). Ask the network directly, regardless of settlement,
  // before trusting the local `nosend` status — a payee holding a scanned
  // static QR may already have broadcast their copy while both devices were
  // offline, and this device has no interactive ack that would have told it.
  const online = await probeConnectivity(isOnlineProbe)
  if (online) {
    if (await chainAlreadyKnows(storage, txid)) return 'already-sent'
  } else if (!acknowledgedUnverifiable) {
    // Genuinely offline: cannot rule out the payee having already broadcast.
    // Refuse to cancel silently — the caller shows the destructive confirm
    // and retries with `acknowledgedUnverifiable: true` if the user accepts
    // the risk.
    return 'unverifiable-offline'
  }

  const r = await wallet.abortAction({ reference: tx.reference }, originator)
  if (r && r.aborted === false) throw new Error('the wallet refused to cancel this payment')

  // Only after the abort landed: a retained parked row is recoverable, a
  // retired row over a live reservation is not.
  await updateOfflineAction(db as never, txid, { status: 'acknowledged' })
  return 'cancelled'
}

/**
 * The UI-facing glue for `cancelParkedPayment`'s `unverifiable-offline`
 * outcome, extracted so it is unit-testable without mounting a screen: call
 * `cancel()` once; only when that comes back `unverifiable-offline` does it
 * show the destructive confirm, and only on acceptance does it call
 * `cancel(true)` to retry with the acknowledgement. Any other outcome (or a
 * declined confirm) is returned as-is, with no second call.
 */
export async function runCancelParkedFlow(deps: {
  cancel: (acknowledgedUnverifiable?: boolean) => Promise<CancelParkedOutcome>
  /** Shows t('local_pay_cancel_unverifiable_title'/'_body'); resolves true only on the destructive confirm. */
  confirmUnverifiable: () => Promise<boolean>
}): Promise<CancelParkedOutcome> {
  const outcome = await deps.cancel(undefined)
  if (outcome !== 'unverifiable-offline') return outcome
  const proceed = await deps.confirmUnverifiable()
  if (!proceed) return outcome
  return deps.cancel(true)
}

/** Same "assume online" direction as build.ts's `finalizeDelivery` probe. */
async function probeConnectivity(isOnlineProbe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await isOnlineProbe()
  } catch (e) {
    devLog('[cancelParkedPayment] connectivity probe failed, assuming online:', e)
    return true
  }
}

/** Mirrors core/storage/methods/processOfflineActions.ts's `networkAlreadyHas`. */
async function chainAlreadyKnows(storage: CancelParkedStorage, txid: string): Promise<boolean> {
  try {
    const services = storage.getServices?.()
    if (!services || typeof services.getStatusForTxids !== 'function') return false
    const r = await services.getStatusForTxids([txid])
    const status = r.results?.find(x => x.txid === txid)?.status
    return status === 'mined' || status === 'known'
  } catch (e) {
    devLog(`[cancelParkedPayment] could not ask the network about ${txid}, treating as unknown:`, e)
    return false
  }
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
