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
import { createSettlementStore, type SettlementDb } from '../mandala/settlementStore'
import type { EvidenceFrame, TokenHandedOverHook } from '../mandala/types'
import type { StorageExpoSQLite } from '../storage/StorageExpoSQLite'

/**
 * The PLAINTEXT frame and the hook that persists what it carries.
 *
 * `framePayload` is the frame SEALED with the nearby session's pre-shared key,
 * and `offline/tokenFrames.ts` keeps that key IN MEMORY ONLY, deliberately — a
 * durable copy of the key that opens every stored frame is exactly what nobody
 * wants on disk. The consequence, until now, was that the payer's own
 * `token_settlements` row existed only as a re-derivation from bytes it could
 * no longer open after a restart: no row, and `processOfflineActions` reads the
 * absence as "this is an ordinary BSV transaction" and broadcasts an unadmitted
 * token tip.
 *
 * So the frame is handed over here, while it is still open, and the row plus
 * its evidence are written from it. `tokenFrames.ts` stays exactly as it was —
 * a best-effort fallback for the rows this process still holds a key for.
 */
export interface TokenHandoverDeps {
  /** The open frame this hand-over is for. Absent on the BSV rail. */
  frame?: EvidenceFrame
  /** Implemented by the Mandala runtime; writes the row and the evidence. */
  onTokenHandedOver?: TokenHandedOverHook
  /**
   * The `createAction` reference of the action that built this tip
   * (`BuiltPayment.reference`), recorded on the settlement row so an
   * `abortAction` against it can be refused once the payee holds the frame.
   * See `core/mandala/abortGuard.ts` — a token action stays `noSend` until the
   * drain broadcasts it, so its reference is the one handle anything has on
   * money that is already gone.
   */
  reference?: string
}

/**
 * Advance this txid's settlement row `parked → handed_over` (§4.4, FIX F).
 *
 * The queue row's own `parked → queued` advance has a settlement twin, and it
 * has to be issued explicitly for the same reason the queue one did:
 * `upsertSettlement` never writes `state` on conflict (rule 1 in
 * `settlementStore.ts`), so a hook re-running over an existing `parked` row
 * leaves it `parked` — and `parked` is the one non-terminal state the drain
 * refuses to submit, by design (FIX F). Without this the payer's optional
 * submit (rule 6) could never start for a payment that was parked first.
 *
 * Best-effort, and it runs AFTER the queue row: the queue row is the durable
 * fact, a settlement row is a re-derivable cache (FIX G), and the drain's own
 * `reconcileSettlements` pass re-runs this population every tick. A wallet on a
 * schema without these tables simply logs.
 */
async function advanceToHandedOver(storage: StorageExpoSQLite, txid: string): Promise<void> {
  const db = storage.sqliteDb
  if (!db) return
  try {
    await createSettlementStore(db as unknown as SettlementDb).advanceSettlement(txid, ['parked'], 'handed_over')
  } catch (e) {
    devLog(`[payerHold] could not advance the settlement row for ${txid} to handed_over:`, e)
  }
}

/**
 * Persist what the plaintext frame carries, for the state this call just put
 * the payment in. Never throws: the queue row is already durable by the time
 * this runs, and a payment that IS queued must not be reported as un-queued
 * because a cache write failed.
 */
async function journalHandover(
  deps: TokenHandoverDeps,
  txid: string,
  state: 'parked' | 'handed_over'
): Promise<void> {
  if (!deps.frame?.token || !deps.onTokenHandedOver) return
  try {
    await deps.onTokenHandedOver(deps.frame, txid, state, deps.reference)
  } catch (e) {
    devLog(`[payerHold] could not journal the ${state} settlement for ${txid}:`, e)
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
    // Same two writes and the same order as the insert path: the durable row
    // first, the promotion after.
    await updateOfflineAction(db, txid, { status: 'queued' })
    TaskSendOffline.noteEnqueued()
    await journalHandover(args, txid, 'handed_over')
    await advanceToHandedOver(storage, txid)
    // Only while still withheld: if the payee already broadcast and this device
    // saw it, the transaction has moved on and this write would be a lie.
    if (tx.status === 'nosend') await storage.updateTransactionStatus('unproven', tx.transactionId)
    return
  }

  // Insert before promote — see the ORDER MATTERS note above.
  await insertOfflineAction(db, { userId: tx.userId, txid, role: 'sent', framePayload })
  TaskSendOffline.noteEnqueued()
  // Queue row first, settlement second, for the reason the ORDER MATTERS note
  // gives: the queue row is what the drain finds, and it is durable. The
  // advance is issued even on this path because a row may already exist at
  // `parked` from a park that never got its queue row written.
  await journalHandover(args, txid, 'handed_over')
  await advanceToHandedOver(storage, txid)
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
): Promise<void> {
  const { storage, txid, framePayload } = args
  const db = storage.sqliteDb
  if (!db) throw new Error('the database is not open, cannot park this payment')

  const tx = (await storage.findTransactions({ partial: { txid }, noRawTx: true }))[0]
  if (!tx) throw new Error(`no transaction record for ${txid}, cannot park it`)

  // No promote, and no TaskSendOffline.noteEnqueued(): both are what turn a
  // stored frame into a broadcast.
  await insertOfflineAction(db, { userId: tx.userId, txid, role: 'sent', framePayload }, 'parked')
  // The row is written at `parked`, which the drain will never submit (FIX F) —
  // but it EXISTS, which is what `processOfflineActions` and
  // `attemptToPostReqsToNetwork` both key their token branch on. That is the
  // durability this call buys and the sealed `framePayload` cannot: after a
  // restart the session PSK is gone and these bytes can no longer be opened.
  await journalHandover(args, txid, 'parked')
}


/**
 * Release a parked payment: the payer showed the code again and this time
 * confirmed the hand-over.
 *
 * The same two writes `holdSentPaymentOffline` makes, minus the insert — the
 * row already exists from parking, so it is flipped to 'queued' instead. Same
 * order for the same reason: the durable row moves first, the promotion after.
 */
export async function releaseParkedPayment(args: { storage: StorageExpoSQLite; txid: string }): Promise<void> {
  const { storage, txid } = args
  const db = storage.sqliteDb
  if (!db) throw new Error('the database is not open, cannot release this payment')

  const tx = (await storage.findTransactions({ partial: { txid }, noRawTx: true }))[0]
  if (!tx) throw new Error(`no transaction record for ${txid}, cannot release it`)

  await updateOfflineAction(db, txid, { status: 'queued' })
  TaskSendOffline.noteEnqueued()
  // The settlement twin of the line above (§4.4). No frame is threaded here —
  // this is the re-show-and-confirm path, and the row was already written from
  // the plaintext frame when the payment was parked — so the state advance is
  // the whole of it.
  await advanceToHandedOver(storage, txid)
  // Already promoted if the payee broadcast and this device saw it; the write
  // is only correct while the transaction is still being withheld.
  if (tx.status === 'nosend') await storage.updateTransactionStatus('unproven', tx.transactionId)
}
