/**
 * The payer's side of the offline queue: record that this payment still needs
 * broadcasting, then promote the withheld transaction so its change is
 * spendable.
 *
 * `buildPaymentFrame` creates the payment with `noSend: true`, which
 * `determineReqTxStatus` (`storage/methods/processAction.js:150-159`) leaves
 * BOTH the request and the transaction at `nosend`. The request staying
 * `nosend` is exactly what the release drain wants — `processOfflineActions`'s
 * `postOwned` posts a request it finds at `nosend` as-is, and deliberately does
 * not promote it first (see that function's comment on why promoting the
 * request would buy nothing and could hand the monitor a chance to broadcast
 * out of order). The TRANSACTION is the one row that must move: a `nosend`
 * transaction's change is invisible to `allocateChangeInput`
 * (`storage/StorageExpoSQLite.ts:1284`, whose status list is
 * `['completed','unproven']` plus optionally `'sending'`), so until this
 * promotion runs, a payer stuck underground could never fund a second offline
 * payment out of the first one's change. `nosend -> unproven` is a pure status
 * write with no output side-effects — only `failed` has any
 * (`StorageProvider.js:397-436`).
 *
 * ORDER MATTERS. The queue-row insert runs FIRST, deliberately, because it is
 * durable and the status promotion is not: nothing in this app re-drives a
 * hold that failed partway (see `finalizeDelivery`'s catch — a thrown hold is
 * reported as `broadcast: 'pending'`, not retried). If the insert lands and
 * the promotion then throws, `processOfflineActions`'s drain still finds this
 * txid's row and will post it — `postOwned` reads whatever transaction status
 * a request's outputs are ALREADY at before posting and only restores that
 * same status on a service error (`processOfflineActions.ts` — "holdSafeTxStatuses
 * admits 'nosend' as well as 'unproven'"), and `attemptToPostReqsToNetwork`
 * promotes the transaction forward on any successful post regardless of what
 * it started at (`attemptToPostReqsToNetwork.js:189-197,268`). So a failed
 * promotion only costs this device the ability to spend this change while
 * still offline; it resolves itself the moment the drain successfully posts
 * the transaction, with no data lost. The reverse order would risk the
 * opposite failure: a promoted-but-unqueued transaction that nothing will
 * ever broadcast, because `processOfflineActions` only ever looks at
 * `offline_actions` rows, and no monitor task sweeps a plain `nosend`
 * transaction to send it — `TaskSendWaiting` selects only
 * `['unsent','sending']`, and `TaskCheckNoSends` (the only task that reads
 * `nosend` rows at all) only requests merkle proofs for transactions that may
 * have been broadcast BY SOME OTHER MEANS; it never calls `sendWith` and never
 * advances status.
 *
 * Deliberately NOT built on `holdReqsOffline` (Task 8): that method's contract
 * is the opposite of this one's job. It takes the transaction status as a
 * PRECONDITION and leaves it untouched — its whole point, on the receiving
 * side, is that `internalizeAction` already left the transaction `unproven`
 * before it runs. Coupling this payer-side promotion into it would mean either
 * bending that documented invariant (risking the receiving path it protects)
 * or calling it and then promoting the transaction separately anyway, which
 * shares nothing. What genuinely is shared — the `offline_actions` insert — is
 * reused directly via `insertOfflineAction`.
 */
import { findOfflineActionByTxid, insertOfflineAction, updateOfflineAction } from '../storage/methods/offlineActions'
import { TaskSendOffline } from '../monitor/TaskSendOffline'
import { devLog } from '../logging'
import type { NearbyTokenDeps } from '../mandala/runtime'
import type { StorageExpoSQLite } from '../storage/StorageExpoSQLite'

/**
 * The token half of a payer hold (plan 07 Task 15).
 *
 * A nearby token payment's durable host record is its `color_transfers` row,
 * journaled `built` by the runtime's `nearby.handover` before any frame
 * existed. Park, hold and release only move that row forward, through the
 * runtime's `nearby.onHandedOver`: `parked` when the payer backed out
 * without confirming, `handed_over` once the payee has (or is known to have)
 * the frame. Nothing here needs the sealed `framePayload` or the session key
 * that opens it. Absent on the BSV rail.
 */
export interface TokenHandoverDeps {
  onHandedOver?: NearbyTokenDeps['onHandedOver']
}

/**
 * Move the journal row for the state this call just put the payment in. Never
 * throws — the caller decides what a failed journal costs, from the boolean
 * this returns. `true` for a plain BSV hold (nothing to journal) and for a
 * token hold whose write landed; `false` only when a token hold's did not.
 */
async function journalHandover(
  deps: TokenHandoverDeps,
  txid: string,
  state: 'parked' | 'handed_over'
): Promise<boolean> {
  if (!deps.onHandedOver) return true
  try {
    await deps.onHandedOver(txid, state)
    return true
  } catch (e) {
    devLog(`[payerHold] could not journal ${txid} as ${state}:`, e)
    return false
  }
}

/**
 * Statuses a second confirm may advance to 'queued'.
 *
 * 'parked' is the case FIX F names: the payer showed the code, walked away,
 * came back and confirmed. 'queued' is included because re-confirming an
 * already-queued payment must be a harmless no-op rather than a refusal.
 * Everything past them — 'sent', 'rejected', 'acknowledged' — is a decided
 * payment, and dragging one back to 'queued' would re-broadcast a transaction
 * the wallet has already failed or cancelled.
 */
const ADVANCEABLE_TO_QUEUED = new Set(['parked', 'queued'])

/**
 * XR-036, re-keyed onto the journal: whether this hold has a journal row to
 * move before its queue row may wake the drain. The broadcast hold already
 * holds any 1Color tx whose row is not `settled` (W1), so this is no longer
 * what keeps a token tx off the network; it is what keeps a queue row from
 * reading "queued" for a payment whose journal never said it was handed over,
 * which nothing would then settle. A plain BSV hold keeps its immediate
 * promotion.
 */
function isTokenHold(deps: TokenHandoverDeps): boolean {
  return deps.onHandedOver !== undefined
}

export async function holdSentPaymentOffline(
  args: TokenHandoverDeps & {
    storage: StorageExpoSQLite
    txid: string
    /** The full bsvpayf1: QR string, persisted so the code can be re-shown later. */
    framePayload?: string
  }
): Promise<void> {
  const { storage, txid, framePayload } = args
  const db = storage.sqliteDb
  if (!db) throw new Error('the database is not open, cannot queue this payment for release')

  // The transaction row is the one authority this needs for both facts: its
  // own transactionId, to promote, and its userId, to attribute the queue row.
  // Resolving userId any other way risks a value unconnected to this payment —
  // and `offline_actions.userId` is a foreign key with enforcement OFF in this
  // app (no `PRAGMA foreign_keys` anywhere), so a wrong id would not fail loudly,
  // it would silently park the payment under a user nothing ever queries. If the
  // transaction cannot be found at all, there is no safe id to fall back to, so
  // this throws rather than guessing — the caller (`finalizeDelivery`) already
  // treats a failed hold as a non-fatal `broadcast: 'pending'`, because the
  // payee holds its own durable copy regardless of whether this device's queue
  // bookkeeping succeeds.
  const tx = (await storage.findTransactions({ partial: { txid }, noRawTx: true }))[0]
  if (!tx) throw new Error(`no transaction record for ${txid}, cannot queue it for release`)

  // FIX F, part 1. `insertOfflineAction` is INSERT OR IGNORE on a UNIQUE txid:
  // with a row already present it proves re-insert idempotency only, never a
  // state advance. So a payer who parked, walked away, came back and confirmed
  // had the insert silently ignored — the row stayed 'parked' forever while
  // the promotion below still moved the transaction past 'nosend', leaving the
  // payment neither drainable ('queued'/'posting' are all the drain reads) nor
  // cancellable (`cancelParkedPayment` refuses anything past 'nosend'). An
  // existing row is therefore ADVANCED rather than re-inserted.
  const existing = await findOfflineActionByTxid(db, txid)
  if (existing) {
    if (!ADVANCEABLE_TO_QUEUED.has(existing.status)) {
      // A decided payment. Neither the queue row nor the transaction may move.
      devLog(`[holdSentPaymentOffline] ${txid} is already '${existing.status}', leaving it alone`)
      return
    }
    if (isTokenHold(args)) {
      // XR-036: do NOT wake the drain until the journal reads handed_over —
      // leave the row exactly where a park would (non-drainable) if the write
      // fails.
      const journaled = await journalHandover(args, txid, 'handed_over')
      if (journaled) {
        await updateOfflineAction(db, txid, { status: 'queued' })
        TaskSendOffline.noteEnqueued()
      } else {
        devLog(`[holdSentPaymentOffline] ${txid} left '${existing.status}': its hand-over could not be journaled`)
      }
    } else {
      // Same two writes and the same order as before: the durable row first,
      // the promotion after — unchanged for the plain BSV rail, which has no
      // journal row to wait for.
      await updateOfflineAction(db, txid, { status: 'queued' })
      TaskSendOffline.noteEnqueued()
    }
    // Only while still withheld: if the payee already broadcast and this device
    // saw it, the transaction has moved on and this write would be a lie.
    if (tx.status === 'nosend') await storage.updateTransactionStatus('unproven', tx.transactionId)
    return
  }

  if (isTokenHold(args)) {
    // XR-036: insert at 'parked' — durable (`findOfflineActions` never reads
    // it, so the drain leaves it alone), and NOT promoted to 'queued' until
    // the journal reads handed_over. A process kill or a transient write
    // fault right here leaves a parked row the payer can still release or
    // cancel, never a queued one for a payment the journal does not know was
    // handed over.
    await insertOfflineAction(db, { userId: tx.userId, txid, role: 'sent', framePayload }, 'parked')
    const journaled = await journalHandover(args, txid, 'handed_over')
    if (journaled) {
      await updateOfflineAction(db, txid, { status: 'queued' })
      TaskSendOffline.noteEnqueued()
    } else {
      devLog(`[holdSentPaymentOffline] ${txid} left 'parked': its hand-over could not be journaled`)
    }
  } else {
    // Insert before promote — see the ORDER MATTERS note above. Unchanged for
    // the plain BSV rail.
    await insertOfflineAction(db, { userId: tx.userId, txid, role: 'sent', framePayload })
    TaskSendOffline.noteEnqueued()
  }
  await storage.updateTransactionStatus('unproven', tx.transactionId)
}

/**
 * Keep a handed-over payment WITHOUT releasing it for broadcast.
 *
 * The payer left the code screen instead of confirming the hand-over, so
 * nothing is known about whether the payee scanned. Holding it would post it —
 * `holdSentPaymentOffline` promotes the transaction and wakes the drain, which
 * is how backing out came to send the payment outright. Parking keeps both
 * possibilities open instead: the frame is stored so the code can be shown
 * again, and the transaction stays `nosend`, so its inputs are still reserved
 * and it can still be aborted.
 *
 * If the payee did scan and broadcasts their copy, the payment settles from
 * their side and this device sees it confirm. If they did not, the payer can
 * cancel and nothing was ever spent.
 */
export async function parkSentPaymentOffline(
  args: TokenHandoverDeps & {
    storage: StorageExpoSQLite
    txid: string
    framePayload?: string
  }
): Promise<boolean> {
  const { storage, txid, framePayload } = args
  const db = storage.sqliteDb
  if (!db) throw new Error('the database is not open, cannot park this payment')

  const tx = (await storage.findTransactions({ partial: { txid }, noRawTx: true }))[0]
  if (!tx) throw new Error(`no transaction record for ${txid}, cannot park it`)

  // No promote, and no TaskSendOffline.noteEnqueued(): both are what turn a
  // stored frame into a broadcast.
  await insertOfflineAction(db, { userId: tx.userId, txid, role: 'sent', framePayload }, 'parked')
  // The queue row is written at `parked`, which the drain never posts, and
  // the journal row moves to `parked`, which nobody settles (FIX F): the
  // payer withheld this payment, and only the payer releases it. The result
  // is returned so a caller can tell a landed journal from a failed one; a
  // plain BSV park resolves `true` (there is nothing to journal).
  return journalHandover(args, txid, 'parked')
}

/**
 * Release a parked payment: the payer showed the code again and this time
 * confirmed the hand-over, or re-delivered it over the message box.
 *
 * The same two writes `holdSentPaymentOffline` makes, minus the insert — the
 * row already exists from parking, so it is flipped to 'queued' instead. Same
 * order for the same reason: the durable row moves first, the promotion after.
 *
 * A token park (`isTokenHold`, which the caller knows from the action's
 * 'mandala' label) is released only through the journal: `onHandedOver`
 * moves its row to `handed_over` first, and when that hook is missing or
 * fails the queue row is left parked. A queued row whose journal never says
 * handed_over is a payment nothing would settle.
 */
export async function releaseParkedPayment(args: {
  storage: StorageExpoSQLite
  txid: string
  isTokenHold?: boolean
  onHandedOver?: NearbyTokenDeps['onHandedOver']
}): Promise<void> {
  const { storage, txid, isTokenHold } = args
  const db = storage.sqliteDb
  if (!db) throw new Error('the database is not open, cannot release this payment')

  const tx = (await storage.findTransactions({ partial: { txid }, noRawTx: true }))[0]
  if (!tx) throw new Error(`no transaction record for ${txid}, cannot release it`)

  if (isTokenHold) {
    if (!args.onHandedOver) {
      devLog(`[releaseParkedPayment] ${txid} left 'parked': no journal hook to release a token hold through`)
      return
    }
    if (!(await journalHandover({ onHandedOver: args.onHandedOver }, txid, 'handed_over'))) {
      devLog(`[releaseParkedPayment] ${txid} left 'parked': its hand-over could not be journaled`)
      return
    }
  }

  await updateOfflineAction(db, txid, { status: 'queued' })
  TaskSendOffline.noteEnqueued()
  // Already promoted if the payee broadcast and this device saw it; the write
  // is only correct while the transaction is still being withheld.
  if (tx.status === 'nosend') await storage.updateTransactionStatus('unproven', tx.transactionId)
}
