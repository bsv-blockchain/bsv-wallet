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
import type { MandalaRuntime } from '../mandala/runtime'
import type { TransferJournal } from '../mandala/transferJournal'
import type { ColorTransferState } from '../mandala/types'

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
 * it always has. For a txid with a `color_transfers` row (plan 07 Task 15) the
 * overlay, not this device, decides whether the payee's own submit already
 * landed: a parked payment the payee scanned may have been admitted, and
 * aborting it then releases inputs the overlay considers spent.
 */
export interface CancelParkedSettlementDeps {
  /**
   * The runtime's `isHandoverAdmitted`: `true` admitted, `false` asked and
   * not admitted, `undefined` could not be asked. It reads this device's own
   * configured overlay through the module's provider, never a URL from a
   * frame or a row.
   */
  isHandoverAdmitted: (txid: string) => Promise<boolean | undefined>
  /** The `color_transfers` journal: the row to protect, and where the outcome is recorded. */
  journal: Pick<TransferJournal, 'get' | 'advance'>
  /** Offline there is nothing to ask, so the local check stands alone. */
  isOnline: () => Promise<boolean>
}

/** Journal states a cancel may still release: the payer's own, plus a final word the money never moved. */
const CANCELLABLE_TRANSFER_STATES: readonly ColorTransferState[] = ['built', 'parked', 'refused', 'cancelled']
/** The states a cancel moves to `cancelled`. */
const PAYER_STATES: readonly ColorTransferState[] = ['built', 'parked']

/**
 * Assembles `CancelParkedSettlementDeps` from the Mandala runtime, for a
 * cancel call site. Returns `undefined` when Mandala is unavailable — passing
 * that straight through as `settlement` leaves `cancelParkedPayment` exactly
 * as it behaves for a plain BSV payment (the local `nosend` check stands
 * alone).
 */
export function mandalaSettlementDeps(
  mandala: Pick<MandalaRuntime, 'available' | 'isHandoverAdmitted' | 'journal'> | undefined,
  isOnline: () => Promise<boolean> = getOnline
): CancelParkedSettlementDeps | undefined {
  if (!mandala?.available) return undefined
  return {
    isHandoverAdmitted: async txid => await mandala.isHandoverAdmitted(txid),
    journal: mandala.journal,
    isOnline
  }
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
  // not this device, decides. The payee's own submit may already have landed
  // (the RECIPIENT settles the hop), in which case aborting would release
  // inputs the overlay has already marked spent and hand the payer a
  // double-spend against the person they just paid.
  //
  // XR-100: a journal row is the signal that this txid was genuinely built
  // as a token hand-over — once one exists, "cannot ask the overlay"
  // (offline, or an `undefined` answer) must not be read as "the overlay says
  // no". Only a txid with NO row at all is safe to fall through with no
  // admission check. A journal read fault propagates: it is not "no row".
  const row = settlement ? await settlement.journal.get(txid) : undefined
  if (settlement && row) {
    // The journal already says the payee has it (or the overlay admitted it):
    // the abort guard would refuse, and the honest answer is "already sent".
    if (!CANCELLABLE_TRANSFER_STATES.includes(row.state)) return 'already-sent'
    if (await isOnline(settlement)) {
      const admitted = await isHandoverAdmittedSafely(settlement, txid)
      if (admitted === true) {
        // Record what the overlay just said, so every later reader (the abort
        // guard, the activity list) agrees with it.
        try {
          await settlement.journal.advance(txid, PAYER_STATES, 'handed_over', { delivered: true })
        } catch (e) {
          devLog(`[cancelParkedPayment] could not journal ${txid} as handed over:`, e)
        }
        return 'already-sent'
      }
      if (admitted === undefined && !acknowledgedUnverifiable) return 'unverifiable-offline'
    } else if (!acknowledgedUnverifiable) {
      // Cannot ask the overlay at all while offline. Same refusal as the
      // BSV-rail check below, and the same escape hatch: the caller shows
      // the destructive confirm and retries with `acknowledgedUnverifiable`.
      return 'unverifiable-offline'
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

  // The money never moved: say so in the journal, after the abort landed (a
  // row journaled cancelled over a live reservation would hide a payment the
  // payer still has to cancel). A journal fault here does not undo the abort,
  // so it is logged, not thrown.
  if (settlement && row) {
    try {
      await settlement.journal.advance(txid, PAYER_STATES, 'cancelled')
    } catch (e) {
      devLog(`[cancelParkedPayment] could not journal ${txid} as cancelled:`, e)
    }
  }

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

/**
 * Mirrors core/storage/methods/processOfflineActions.ts's `networkAlreadyHas`.
 * Exported (XR-095) so build.ts's `finalizeDelivery` can run the identical
 * check before releasing inputs on a decline, instead of re-implementing it.
 */
export async function chainAlreadyKnows(storage: CancelParkedStorage, txid: string): Promise<boolean> {
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
 * Treating the failure as offline routes it through the same
 * `acknowledgedUnverifiable` gate as a genuinely offline device (XR-100) when
 * a settlement row exists — it is not the "safe to fall through" case, only a
 * different way of not being able to ask.
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
 * XR-100: "the overlay could not be asked" is a THIRD answer, not a synonym
 * for "not admitted". The runtime's `isHandoverAdmitted` already answers
 * `undefined` for an unreachable overlay; a probe that throws outright is
 * folded into the same `undefined`, so `cancelParkedPayment` cannot mistake
 * "could not ask" for "asked, and the answer was no".
 */
async function isHandoverAdmittedSafely(deps: CancelParkedSettlementDeps, txid: string): Promise<boolean | undefined> {
  try {
    return await deps.isHandoverAdmitted(txid)
  } catch (e) {
    devLog(`[cancelParkedPayment] could not ask the overlay about ${txid}:`, e)
    return undefined
  }
}
