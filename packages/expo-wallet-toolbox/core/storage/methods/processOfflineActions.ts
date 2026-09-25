/**
 * Releases held transactions to the network, parents first.
 *
 * The order comes from the BEEF, not from the queue: a received transaction's
 * ancestry can contain other people's unbroadcast transactions that were never
 * our queue rows, and those must go out before ours. Every held request stores
 * the full AtomicBEEF it arrived in (`proven_tx_reqs.inputBEEF`, written at
 * `storage/methods/internalizeAction.js:519`), so merging those beefs gives the
 * whole dependency graph.
 *
 * Transactions we own are posted through the toolbox's own
 * `attemptToPostReqsToNetwork`, which handles status transitions, history notes
 * and `markStaleInputsAsSpent`. Foreign ancestors have no request here, so they
 * are posted directly through `services.postBeef`.
 *
 * Every decision — the order, what a broadcast result means, who dies with whom
 * — lives in `utils/offline/plan.ts` and is unit-tested. What is left here is
 * database reads, writes and logging, which is validated on device.
 */
import { Beef } from '@bsv/sdk'
import { attemptToPostReqsToNetwork, EntityProvenTx, EntityProvenTxReq } from '@bsv/wallet-toolbox-mobile'
import type { TableProvenTxReq, TableTransaction } from '@bsv/wallet-toolbox-mobile'
import type { StorageExpoSQLite } from '../StorageExpoSQLite'
import { findOfflineActions, updateOfflineAction, type OfflineActionRow, type OfflineDb } from './offlineActions'
import {
  applyOutcome,
  outcomeFromReqStatus,
  outcomeOfForeignPost,
  outcomeOfOwnedPost,
  planRelease,
  undecidedReqStatuses,
  type PostOutcome
} from '../../offline/plan'
import { descendantsOf, type OrderableTx } from '../../offline/order'
import { postTokenStep, reconcileSettlements, type TokenFrameSource } from '../../mandala/drain'
import type { AdmissionVerifier, CoverFn, SettlementStore, SubmitFn, TokenSettlementRow } from '../../mandala/types'
import { devLog } from '../../logging'
import { getOnline } from '../../net/online'

/** i18n keys for `stalledOn` — OfflineNotice translates these, never raw txids. */
export const STALL_NO_REQUEST = 'offline_stall_no_request'
export const STALL_BAD_BEEF = 'offline_stall_bad_beef'
export const STALL_FOREIGN_ANCESTOR = 'offline_stall_foreign_ancestor'

export interface ProcessOfflineActionsResult {
  /** Queue rows moved to 'sent'. A foreign ancestor's broadcast is logged, not counted. */
  sent: number
  /**
   * Transactions whose local records were changed to record a rejection.
   * Includes both a rejection this pass's own cascade decided and a stale
   * 'sent' row this pass reconciled against a since-invalidated request
   * (XQ-009 remainder) — both are "a local record changed to record a
   * rejection", and neither needs its own counter.
   */
  rejected: number
  /**
   * True if at least one subtree of the plan could not finish and was left
   * queued. The run itself always walks the whole plan — a blocked subtree no
   * longer aborts release of the rest — so this reports partial, not total,
   * failure; there may still be more to do next pass.
   */
  stopped: boolean
  /**
   * Why the queue cannot make progress by simply being retried.
   *
   * Distinct from `stopped`, which is also true for the ordinary "signal went away
   * again" case that the next run resolves by itself. This is set only where
   * retrying changes nothing: a queued transaction whose request has gone, one
   * whose beef will not parse, or an ancestor from someone else's beef that no
   * service will accept. Left conservative, all three leave their rows at 'queued'
   * with the received outputs still spendable and tell the user nothing — nothing
   * else in the system records them, so a caller must surface this.
   */
  stalledOn?: string
}

/** A queued transaction paired with the request that carries its bytes. */
interface HeldAction {
  row: OfflineActionRow
  api: TableProvenTxReq
}

/**
 * Everything the Mandala settlement drain needs that this module cannot do
 * itself. Absent for a wallet with no token payments — then not one line of
 * behaviour below changes.
 *
 * `cover` and `submit` are injected rather than imported because one is a pure
 * verifier over local evidence and the other is a network call; keeping both
 * out of here is what leaves this file a database-and-ordering module.
 */
export interface OfflineTokenDeps {
  store: SettlementStore
  cover: CoverFn
  submit: SubmitFn
  /**
   * FIX H / wire contract §9.10. THIS WALLET's configured overlay identity key
   * and the σ_I verifier that checks against it — the only thing that may let a
   * cached admission skip a `/submit`, and the filter on what the evidence
   * cache is allowed to keep at all. Absent and nothing is trusted: every
   * ancestor is submitted, which is free and always correct.
   */
  overlayIdentityKey?: string
  verifyAdmission?: AdmissionVerifier
  /**
   * Clear `@bsv/mandala`'s tx-journal entry for a tip this pass really
   * broadcast. See `TokenStepDeps.journalRemove`; passed straight through so
   * the drain's own broadcast is the only thing that can clear one.
   */
  journalRemove?: (txid: string) => Promise<void>
  /**
   * FIX G: every durable token frame this device holds, re-read each pass so
   * the evidence tables and the settlement rows are re-derived idempotently
   * before anything is decided. Supplied by the caller because only it can
   * open a payer-side sealed `framePayload`.
   */
  frames?: () => Promise<TokenFrameSource[]>
}

export async function processOfflineActions(args: {
  storage: StorageExpoSQLite
  /** Injected so tests can supply a missing ancestor without hitting the network. */
  refetchBeef?: (txid: string) => Promise<number[] | undefined>
  /** Mandala settlement. Omit entirely and the drain behaves exactly as before. */
  token?: OfflineTokenDeps
}): Promise<ProcessOfflineActionsResult> {
  const { storage, refetchBeef, token } = args
  const db = storage.sqliteDb
  if (!db) return { sent: 0, rejected: 0, stopped: true, stalledOn: 'the database is not open' }

  // Before anything is read or decided: re-derive the settlement evidence from
  // the frame bytes that are already durable (FIX G). Purely local, so it runs
  // even on a pass that turns out to be offline, and it is allowed to fail —
  // it is a cache-population step, and the next tick repeats it.
  if (token?.frames) {
    try {
      const r = await reconcileSettlements({
        store: token.store,
        sources: await token.frames(),
        overlayIdentityKey: token.overlayIdentityKey,
        verifyAdmission: token.verifyAdmission
      })
      if (r.errors.length > 0) devLog('[processOfflineActions] evidence reconciliation reported:', r.errors)
      if (r.dropped > 0) {
        // FIX H: counterparty-supplied σ_I that did not verify against this
        // wallet's configured overlay key. Not an error and not a decline —
        // the ancestors are simply submitted rather than skipped.
        devLog(`[processOfflineActions] dropped ${r.dropped} unverifiable admission(s) from frame evidence`)
      }
    } catch (e) {
      devLog('[processOfflineActions] could not reconcile token settlements:', e)
    }
  }

  // XQ-009 remainder: a row this device once honestly marked 'sent' (real
  // proof, or a real broadcast) can still have its backing request later
  // reclaimed by the toolbox's own proof-timeout machinery
  // (`EntityProvenTxReq`'s `applyProofTimeout`, reached from `TaskSendWaiting`
  // once `attempts` runs out) if the transaction never actually confirms — a
  // reorg, or a rarer race. When that happens the toolbox's OWN request row
  // already reflects it (`status: 'invalid'`) and has already reclaimed the
  // spendable inputs; this queue's own 'sent' row just never learns about it,
  // leaving the activity list and any resend logic reading a stale success
  // forever. Purely local and read-only against the toolbox's own tables —
  // it never re-broadcasts, aborts, or writes a transaction/request row
  // itself, only brings this queue's bookkeeping in line with a decision the
  // toolbox already made — so it runs unconditionally, before the
  // connectivity probe and even when there is nothing else to do this pass.
  const staleReconciled = await reconcileStaleSentActions(storage, db)

  // 'posting' is included so a run interrupted mid-flight resumes rather than
  // stranding its rows. Re-posting is safe: a transaction the network already has
  // comes back as accepted (ARC's `SEEN_ON_NETWORK`), and a request storage has
  // already recorded as delivered is not posted again at all — see `postOwned`.
  const queued = await findOfflineActions(db, { status: ['queued', 'posting'] })
  if (queued.length === 0) return { sent: 0, rejected: staleReconciled, stopped: false }

  // BEFORE the connectivity probe, because it needs none: a row whose request
  // storage already records as delivered ('unmined', 'completed', …) has
  // nothing left to post. Until now that fact was only read inside `postOwned`,
  // i.e. only on a pass that got past the probe and stepped the row — so a
  // token tip that `settleNow` broadcast the moment it was handed over, or that
  // the payee broadcast and this device later saw mined, kept its queue row at
  // 'queued' (blue "settled", the "waiting" banner, no Refresh chip) whenever
  // the drain was offline, stalled on a sibling, or never reached the step
  // (2026-09-16).
  const rows: OfflineActionRow[] = []
  let sent = 0
  for (const row of queued) {
    const api = await findReq(storage, row.txid)
    if (api && outcomeFromReqStatus(api.status) === 'success') {
      devLog(`[processOfflineActions] storage already records '${api.status}' for ${row.txid}; closing its queue row`)
      await updateOfflineAction(db, row.txid, { status: 'sent' })
      if (token) await closeSettlementAsBroadcast(token.store, row.txid)
      sent++
    } else {
      rows.push(row)
    }
  }
  if (rows.length === 0) return { sent, rejected: staleReconciled, stopped: false }

  if (!(await probeOnline())) {
    devLog(`[processOfflineActions] offline, leaving ${rows.length} action(s) queued`)
    return { sent, rejected: staleReconciled, stopped: true }
  }

  // Merge every held request's BEEF into one graph. Anything that cannot be read
  // is collected rather than thrown: a row missing from the graph is simply never
  // planned, which is safe but permanent, so it has to be reportable.
  const merged = new Beef()
  const held = new Map<string, HeldAction>()
  const blocked: string[] = []
  for (const row of rows) {
    const api = await findReq(storage, row.txid)
    if (!api) {
      devLog(`[processOfflineActions] queued txid has no request, cannot release it: ${row.txid}`)
      blocked.push(STALL_NO_REQUEST)
      continue
    }
    // The request is remembered whatever happens below. Being in `held` does not
    // put anything in the plan — the plan comes from the graph — so a row whose
    // own beef failed can still be released properly if another row's beef
    // supplied it, ordered, as an ancestor.
    held.set(row.txid, { row, api })
    try {
      // ALL OR NOTHING, and this is why: `Beef.mergeBeef` is not atomic. It
      // parses the bytes into a standalone object first, but then merges
      // transaction by transaction into `this`, and `mergeBeefTx` can throw
      // partway through. Merging the raw transaction straight into `merged`
      // before its beef is worse still — a beef that fails to parse at all
      // leaves the child in the graph with none of its ancestors.
      //
      // Nothing downstream can tell that apart from a child whose parents are
      // already mined: `releaseOrder` finds no in-set input, calls it unblocked
      // and posts it first, the network refuses it as an orphan, and the cascade
      // marks it and everything spending it 'failed'. That is received money made
      // permanently unspendable by our own ordering error rather than by any
      // verdict the network reached — the one outcome this engine exists to
      // prevent. So each row is assembled in isolation and folded in only once
      // the whole of it parsed.
      //
      // The fold cannot itself half-succeed the way the parse can: `scratch` is
      // already a live `Beef`, and `mergeBeefTx` only throws for an entry that is
      // neither txid-only nor carrying bytes, which `BeefTx.isTxidOnly` makes
      // unrepresentable.
      const scratch = new Beef()
      scratch.mergeRawTx(api.rawTx)
      if (api.inputBEEF) scratch.mergeBeef(api.inputBEEF)
      merged.mergeBeef(scratch)
    } catch (e) {
      // Without its whole beef this transaction has no place in the graph, so it
      // is simply not planned and stays queued. Never guess at an order.
      // Before stalling, try a network refetch — a missing ancestor that is
      // already on chain can rebuild the graph.
      devLog(`[processOfflineActions] could not merge the beef of ${row.txid}:`, e)
      const repaired = refetchBeef ? await tryMergeRefetchedBeef(merged, row.txid, refetchBeef) : false
      if (!repaired) blocked.push(STALL_BAD_BEEF)
    }
  }

  if (refetchBeef) {
    for (const t of [...merged.txs]) {
      if (t.isTxidOnly) await tryMergeRefetchedBeef(merged, t.txid, refetchBeef)
    }
  }

  const txs: OrderableTx[] = merged.txs
  const plan = planRelease({ rows, txs })

  let rejected = staleReconciled
  const resolved = new Set<string>()
  const skip = new Set<string>()
  const stallNotes: string[] = blocked.length > 0 ? [...blocked] : []

  for (const step of plan) {
    // `resolved` covers a txid the cascade already rejected earlier in this same
    // pass: dependency order guarantees such a descendant's own `step` is still
    // ahead in the plan, and `skip` alone never catches it because
    // invalidTx/doubleSpend return `blocked: []` (a rejection is final, nothing
    // deferred). Without this, the loop walks straight back into an already-
    // rejected row, flips it 'posting', and re-posts a network-refused
    // transaction.
    if (skip.has(step.txid) || resolved.has(step.txid)) continue
    const action = step.owned ? held.get(step.txid) : undefined
    if (step.owned && !action) {
      // Its request is gone, so it can never be posted — and nothing downstream
      // of it may go out either, or it becomes an orphan. Skip the subtree and
      // keep releasing independent roots: this is a local anomaly, not a
      // network verdict, and 'failed' is not reversible.
      skip.add(step.txid)
      for (const d of descendantsOf(step.txid, txs)) skip.add(d)
      stallNotes.push(STALL_NO_REQUEST)
      continue
    }
    if (action) await updateOfflineAction(db, step.txid, { status: 'posting' })

    // The ONE token branch. A transaction with a `token_settlements` row may
    // not be broadcast until the issuer's overlay has admitted it and every
    // unadmitted token ancestor it spends — so the ordinary post becomes
    // `postTokenStep`'s injected `broadcast`, reached only after `/submit`
    // says yes. Everything after this line — applyOutcome, the cascade, the
    // requeue — is unchanged, because `postTokenStep` returns the same
    // `PostOutcome` shape a BSV post does.
    const read = token ? await readSettlement(token.store, step.txid) : { ok: true as const, row: undefined }
    const broadcast = async () =>
      action ? await postOwned(storage, action.api) : await postForeign(storage, merged, step.txid)
    const outcome = !read.ok
      ? // The read failed, so this step does not know whether it is a token
        // transaction. Stall it: `serviceError` leaves every row where it was
        // and retries the whole prefix next pass.
        ('serviceError' as PostOutcome)
      : read.row
        ? await postTokenStep(
            {
              store: token!.store,
              cover: token!.cover,
              submit: token!.submit,
              overlayIdentityKey: token!.overlayIdentityKey,
              verifyAdmission: token!.verifyAdmission,
              journalRemove: token!.journalRemove,
              broadcast
            },
            read.row,
            step
          )
        : await broadcast()
    // A cascade needs to see what spends the refused transaction, and beefs only
    // reach backwards, so the graph the queue built cannot contain a spender that
    // is not itself queued. Widened only when a cascade is actually about to run,
    // because that widening reads every undecided request in the wallet.
    const cascadeTxs = outcome === 'success' || outcome === 'serviceError' ? txs : await withLocalSpenders(storage, txs)
    const result = applyOutcome({ txid: step.txid, outcome, txs: cascadeTxs, rows })

    for (const txid of result.sent) {
      resolved.add(txid)
      if (held.has(txid)) {
        await updateOfflineAction(db, txid, { status: 'sent' })
        sent++
      } else {
        devLog(`[processOfflineActions] foreign ancestor broadcast: ${txid}`)
      }
    }
    for (const r of result.rejected) {
      resolved.add(r.txid)
      try {
        if (await rejectOne(storage, db, held.get(r.txid)?.row, r)) rejected++
      } catch (e) {
        // The walk must reach the parent. A child's failure has already released
        // the parent's outputs back to spendable, so abandoning the cascade here
        // would leave refused money spendable — the exact outcome children-first
        // ordering exists to prevent.
        devLog(`[processOfflineActions] could not record the rejection of ${r.txid}:`, e)
      }
    }
    for (const b of result.blocked) skip.add(b)
    if (result.blocked.length > 0 && !action) {
      // A foreign ancestor no service would take blocks everything behind it and
      // retrying will not change that, whereas our own failed post is the
      // ordinary "signal went away" case the next run picks up.
      stallNotes.push(STALL_FOREIGN_ANCESTOR)
    }
  }

  await requeue(db, plan, resolved)
  const uniqueStalls = [...new Set(stallNotes)]
  return {
    sent,
    rejected,
    stopped: skip.size > 0,
    stalledOn: uniqueStalls.length > 0 ? uniqueStalls.join('; ') : undefined
  }
}

/**
 * Whether this txid has a settlement row — or whether the question could not be
 * answered at all.
 *
 * The three outcomes are deliberately distinct, and the third is the fix. A
 * thrown read (a locked database, a schema without these tables, a corrupt
 * page) USED to fall back to `undefined`, which the caller cannot tell from
 * "this is an ordinary BSV transaction" — so a read fault sent an unadmitted
 * token tip straight to `broadcast()`, defeating the whole §4.3 gate on exactly
 * the kind of transient fault the drain is built to survive. "I could not tell"
 * must never resolve to "go ahead": the caller turns it into `serviceError`,
 * the rows stay where they are, and the next pass asks again.
 *
 * The token guard in `StorageExpoSQLite.attemptToPostReqsToNetwork` reads the
 * same table and would usually catch the same case — but it is reached only
 * from `shareReqsWithWorld`, and `postForeign` does not go through it at all.
 * Two independent barriers are worth having; one of them failing open is not.
 */
type SettlementRead = { ok: true; row: TokenSettlementRow | undefined } | { ok: false }

async function readSettlement(store: SettlementStore, txid: string): Promise<SettlementRead> {
  try {
    return { ok: true, row: await store.getSettlement(txid) }
  } catch (e) {
    devLog(`[processOfflineActions] could not read the settlement row for ${txid}:`, e)
    return { ok: false }
  }
}

async function tryMergeRefetchedBeef(
  target: Beef,
  txid: string,
  refetch: (txid: string) => Promise<number[] | undefined>
): Promise<boolean> {
  try {
    const bytes = await refetch(txid)
    if (!bytes) return false
    const scratch = new Beef()
    scratch.mergeBeef(bytes)
    target.mergeBeef(scratch)
    return true
  } catch (e) {
    devLog(`[processOfflineActions] refetch of ${txid} could not be merged:`, e)
    return false
  }
}

/**
 * A failed connectivity probe must not stop the drain: assume online and let the
 * post itself be the evidence, exactly as the offline hold assumes online when
 * its own probe fails.
 */
async function probeOnline(): Promise<boolean> {
  try {
    return await getOnline()
  } catch (e) {
    devLog('[processOfflineActions] connectivity probe failed, assuming online:', e)
    return true
  }
}

/**
 * The release graph plus every locally-known transaction that has not been
 * decided yet, so a cascade can find the spenders of a refused transaction.
 *
 * These are exactly the descendants with no queue row of their own: the wallet
 * re-spent money it received underground, and Task 8 leaves such an outgoing
 * request to `TaskSendWaiting` rather than parking it, so nothing put it in the
 * queue. They are added for the cascade only and never for release — this engine
 * has no request bookkeeping to offer them, and the monitor already owns sending
 * them. Which statuses count as undecided is a money decision and lives with the
 * others in `utils/offline/plan.ts`.
 *
 * A failure to read them widens nothing rather than throwing, so a cascade still
 * runs over the queue's own graph. Every error here costs rejections we should
 * have made, never rejections we should not have.
 */
async function withLocalSpenders(storage: StorageExpoSQLite, txs: OrderableTx[]): Promise<OrderableTx[]> {
  const known = new Set(txs.map(t => t.txid))
  const spenders = new Beef()
  let pending: TableProvenTxReq[] = []
  try {
    pending = await storage.findProvenTxReqs({ partial: {}, status: undecidedReqStatuses })
  } catch (e) {
    devLog('[processOfflineActions] could not read undecided requests, cascading over the queue alone:', e)
    return txs
  }
  for (const api of pending) {
    if (known.has(api.txid)) continue
    try {
      spenders.mergeRawTx(api.rawTx)
    } catch (e) {
      devLog(`[processOfflineActions] could not read the raw transaction of ${api.txid}:`, e)
    }
  }
  return [...txs, ...spenders.txs.filter(t => !known.has(t.txid))]
}

/**
 * The request for a txid, or undefined if there is none or it could not be read.
 *
 * Guarded because every caller has something safer to do with a failed read than
 * abandon the run: the merge loop leaves the row unplanned, `postOwned` falls back
 * to 'serviceError' and re-holds, and `rejectOne` still records what it can.
 */
async function findReq(storage: StorageExpoSQLite, txid: string): Promise<TableProvenTxReq | undefined> {
  try {
    return (await storage.findProvenTxReqs({ partial: { txid } }))[0]
  } catch (e) {
    devLog(`[processOfflineActions] could not read the request for ${txid}:`, e)
    return undefined
  }
}

/**
 * XQ-009 remainder: bring a 'sent' queue row back in line once its backing
 * request has since been invalidated.
 *
 * A row only ever reaches 'sent' from either a real, verified proof
 * (`postOwned`/`postForeign`'s Merkle-path-checked `networkAlreadyHas`) or
 * this device's own successful broadcast — never from a bare, unauthenticated
 * status claim (that is exactly what XQ-009's own fix closed). What this
 * reconciles is the narrower case left after that: a transaction that really
 * did look delivered at the time can still fail to confirm — a reorg, or a
 * rarer race — and the toolbox's OWN monitor eventually notices on its own
 * timeline (`EntityProvenTxReq`'s proof-timeout marks the request `invalid`
 * once its retry budget is exhausted, `TaskSendWaiting` reclaiming the
 * spendable inputs as part of that). Nothing here decides any of that, or
 * touches a proven_tx_req/transaction row at all — it only reads what the
 * toolbox already decided and updates this queue's OWN bookkeeping table to
 * match, so the activity list and any resend logic stop reading a stale
 * 'sent' as reality. Never re-broadcasts, never releases or aborts anything.
 *
 * Read-only against `findOfflineActions`/`findReq`, both already
 * fault-tolerant (a read failure there returns nothing, not a throw), so a
 * failure here costs only a skipped row for one pass, not the rest of the
 * run — errors are still caught around the one write, for the same reason.
 */
async function reconcileStaleSentActions(storage: StorageExpoSQLite, db: OfflineDb): Promise<number> {
  let sentRows: OfflineActionRow[]
  try {
    sentRows = await findOfflineActions(db, { status: ['sent'] })
  } catch (e) {
    devLog('[processOfflineActions] could not read sent rows to reconcile:', e)
    return 0
  }
  let reconciled = 0
  for (const row of sentRows) {
    const api = await findReq(storage, row.txid)
    if (api?.status !== 'invalid') continue
    try {
      await updateOfflineAction(db, row.txid, { status: 'rejected', rejectedReason: 'proof_timeout' })
      devLog(`[processOfflineActions] reconciled stale 'sent' row ${row.txid}: its request is now 'invalid'`)
      reconciled++
    } catch (e) {
      devLog(`[processOfflineActions] could not reconcile stale 'sent' row ${row.txid}:`, e)
    }
  }
  return reconciled
}

/** Return every unresolved row we may have moved to 'posting' to 'queued'. */
async function requeue(db: OfflineDb, plan: { txid: string; owned: boolean }[], resolved: Set<string>): Promise<void> {
  for (const step of plan) {
    if (!step.owned || resolved.has(step.txid)) continue
    await updateOfflineAction(db, step.txid, { status: 'queued' })
  }
}

/**
 * Post a transaction this wallet owns, reusing the toolbox's bookkeeping.
 *
 * The module function is imported and called directly rather than as
 * `storage.attemptToPostReqsToNetwork`, so Task 8's offline override cannot
 * intercept it. That matters for more than tidiness: the override returns
 * `status: 'success'` for a request it merely parked, and a drain that read that
 * as delivery would mark the queue row 'sent' for a transaction nobody has. The
 * outcome is therefore taken from what storage records, not from what the post
 * reports — see `outcomeOfOwnedPost`.
 *
 * The request is left at 'nosend' for the post. `attemptToPostReqsToNetwork` has
 * no status gate (it screens on rawTx, notify.transactionIds and inputBEEF only,
 * `attemptToPostReqsToNetwork.js:61-99`), so promoting it first would buy nothing
 * and would briefly publish it at 'unsent' — the status `TaskSendWaiting` selects
 * — handing the monitor a chance to broadcast it out of dependency order.
 *
 * On anything but success the hold is restored. A service error otherwise leaves
 * the request at 'sending' with `attempts` incremented
 * (`attemptToPostReqsToNetwork.js:249-253`), which is exactly the state
 * `TaskSendWaiting` picks up every five minutes and `applyProofTimeout` eventually
 * marks 'invalid' (`EntityProvenTxReq.js:426-433`). Leaving it there would hand
 * back the very failure the hold exists to prevent, and out of dependency order at
 * that.
 *
 * That makes the post itself throwing the dangerous case, because the toolbox
 * persists the request's new status and only afterwards touches the transaction
 * rows and — on a failure — runs `markStaleInputsAsSpent`, which does live chain
 * queries. A throw past that first write would otherwise leave 'sending' behind
 * with no re-hold. So the post is guarded and a throw simply leaves `detailStatus`
 * undefined, letting the persisted status decide, which is what decides anyway.
 * The drain recovers from a stalled run; it cannot recover from an out-of-order
 * broadcast.
 */
async function postOwned(storage: StorageExpoSQLite, api: TableProvenTxReq): Promise<PostOutcome> {
  const recorded = outcomeFromReqStatus(api.status)
  if (recorded !== undefined) {
    devLog(`[processOfflineActions] storage already records '${api.status}' for ${api.txid}, not posting`)
    return recorded
  }

  // The second witness: the network itself. A nearby payment is broadcast by
  // whichever side has signal first, and that is routinely the PAYEE — so the
  // payer's own request is still 'nosend' for a transaction that is already in
  // a mempool or a block. Re-posting it is at best a no-op and at worst a
  // broadcaster's "inputs already spent"-shaped error that `outcomeOfOwnedPost`
  // can only read as serviceError: re-held, re-queued, and stuck on every tick
  // while the activity list says settled (2026-09-16). Asking first costs one
  // status lookup and lets storage record what already happened.
  if (await networkAlreadyHas(storage, api.txid, api.rawTx)) {
    devLog(`[processOfflineActions] the network already has ${api.txid}; recording delivery without a post`)
    await recordDeliveredElsewhere(storage, api)
    return 'success'
  }

  const attemptsBefore = api.attempts
  const req = new EntityProvenTxReq(api)
  // What to restore each transaction to, read before the post overwrites it.
  // `holdSafeTxStatuses` admits 'nosend' as well as 'unproven', and a deliberately
  // withheld transaction must not come back claiming it had been broadcast.
  const txStatusBefore = new Map<number, TableTransaction['status']>()
  for (const transactionId of req.notify.transactionIds ?? []) {
    try {
      const tx = (await storage.findTransactions({ partial: { transactionId }, noRawTx: true }))[0]
      if (tx) txStatusBefore.set(transactionId, tx.status)
    } catch (e) {
      devLog(`[processOfflineActions] could not read the status of transaction ${transactionId}:`, e)
    }
  }

  let detailStatus: string | undefined
  try {
    const posted = await attemptToPostReqsToNetwork(storage, [req])
    detailStatus = posted.details.find(d => d.txid === api.txid)?.status
  } catch (e) {
    devLog(`[processOfflineActions] posting ${api.txid} threw:`, e)
  }
  // An independent read: whatever the post claimed, or failed to claim, storage is
  // the witness that the transaction actually left.
  const reqStatus = (await findReq(storage, api.txid))?.status
  const outcome = outcomeOfOwnedPost({ detailStatus, reqStatus })
  devLog(`[processOfflineActions] posted ${api.txid}: reported '${detailStatus}', stored '${reqStatus}' => ${outcome}`)
  if (outcome !== 'serviceError') return outcome

  // Re-hold, and put each transaction back to the hold-safe status it actually
  // had, so its outputs stay spendable and nothing sweeps it while we wait for
  // signal. `attempts` is restored too, so repeated releases while signal comes and
  // goes cannot age a held request toward 'invalid'. The request first, because it
  // is the write that keeps the monitor out and the transaction writes can throw.
  await storage.updateProvenTxReq(api.provenTxReqId, { status: 'nosend', attempts: attemptsBefore })
  for (const [transactionId, status] of txStatusBefore) {
    try {
      await storage.updateTransactionStatus(status, transactionId)
    } catch (e) {
      devLog(`[processOfflineActions] could not restore transaction ${transactionId} to '${status}':`, e)
    }
  }
  return 'serviceError'
}

/**
 * `postOwned` for ONE txid, for a caller outside the queue loop.
 *
 * The Mandala runtime's `settleNow` needs a broadcast to hand `postTokenStep`
 * the moment a hand-over lands, and it must be the SAME broadcast the drain
 * uses — status transitions, history notes, `markStaleInputsAsSpent`, the
 * re-hold on a service error, and the "storage is the witness, not the reported
 * status" rule all live in `postOwned` and must not be reimplemented beside it.
 * So this is the whole of the new surface: find the request, post it, report
 * the same `PostOutcome`.
 *
 * A txid with no request of this wallet's own comes back `'serviceError'`
 * rather than being posted some other way. That is deliberate: a FOREIGN
 * ancestor is only ever broadcast as part of an ordered release over the merged
 * graph (`postForeign`, from the plan), and guessing at that order from one
 * txid is exactly the out-of-dependency-order broadcast this engine exists to
 * prevent. `'serviceError'` leaves the row untouched for the next drain pass,
 * which has the graph.
 */
export async function postOwnedByTxid(storage: StorageExpoSQLite, txid: string): Promise<PostOutcome> {
  const api = await findReq(storage, txid)
  if (!api) {
    devLog(`[processOfflineActions] no request of our own for ${txid}; leaving its broadcast to the drain`)
    return 'serviceError'
  }
  return await postOwned(storage, api)
}

/** Whatever `EntityProvenTx.fromTxid` actually needs — extracted rather than
 * importing the (unexported) `WalletServices` type by name. */
type ProvenTxServices = Parameters<typeof EntityProvenTx.fromTxid>[1]

/**
 * Whether the network already has `txid`, PROVEN.
 *
 * XQ-009: a bare `getStatusForTxids` 'mined'/'known' string costs nothing for
 * an attacker who controls, or MITMs, the status endpoint — and both callers
 * below treat a `true` answer as licence to skip this device's own broadcast
 * and record the transaction as durably delivered, with no reconciliation
 * path if that later turns out to be wrong. So the status string is only the
 * cheap first check; a positive answer must still be confirmed by the same
 * chain-tracker-validated proof the toolbox's own `TaskCheckForProofs`
 * already trusts (`EntityProvenTx.fromTxid`) — this device's OWN `rawTx`
 * (never fetched from the network) plus a Merkle path whose root validates
 * against this wallet's independently-maintained chain tracker. Forging a
 * status string is free; forging a Merkle path that validates against a real
 * chain tracker would require actually getting the transaction mined.
 *
 * `rawTx` is optional only so a caller with no local copy of the candidate
 * transaction (a foreign ancestor whose beef entry is txid-only) degrades to
 * the pre-existing "no proof, no shortcut" answer rather than skipping proof
 * entirely — it never widens what counts as proof.
 *
 * Every failure — no such service, a transport fault, an unexpected shape, no
 * valid proof — is `false`: the answer then falls back to the ordinary post,
 * whose own result decides. Never a reason to stall.
 */
async function networkAlreadyHas(storage: StorageExpoSQLite, txid: string, rawTx?: number[]): Promise<boolean> {
  try {
    const services = storage.getServices() as ProvenTxServices & {
      getStatusForTxids?: (txids: string[]) => Promise<{ results?: { txid: string; status: string }[] }>
    }
    if (typeof services.getStatusForTxids !== 'function') return false
    const r = await services.getStatusForTxids([txid])
    const status = r.results?.find(x => x.txid === txid)?.status
    if (status !== 'mined' && status !== 'known') return false
    if (!rawTx) return false
    const { proven } = await EntityProvenTx.fromTxid(txid, services, rawTx)
    return proven !== undefined
  } catch (e) {
    devLog(`[processOfflineActions] could not ask the network whether it has ${txid}:`, e)
    return false
  }
}

/**
 * Record that `txid` reached the network by someone else's hand, exactly as the
 * toolbox records its own successful post (`updateReqsFromAggregateResults`:
 * request 'unmined', transaction 'unproven'). Only a transaction still at a
 * pre-broadcast status is moved; anything past that is left to the monitor,
 * which owns proofs and 'completed'.
 */
async function recordDeliveredElsewhere(storage: StorageExpoSQLite, api: TableProvenTxReq): Promise<void> {
  await storage.updateProvenTxReq(api.provenTxReqId, { status: 'unmined' })
  const req = new EntityProvenTxReq(api)
  for (const transactionId of req.notify.transactionIds ?? []) {
    try {
      const tx = (await storage.findTransactions({ partial: { transactionId }, noRawTx: true }))[0]
      if (tx && (tx.status === 'nosend' || tx.status === 'sending')) {
        await storage.updateTransactionStatus('unproven', transactionId)
      }
    } catch (e) {
      devLog(`[processOfflineActions] could not promote transaction ${transactionId} of ${api.txid}:`, e)
    }
  }
}

/**
 * The settlement twin of closing a queue row on a recorded delivery: the same
 * advance `broadcastAdmittedTip` makes after a real post. Best-effort — the
 * queue row is the durable fact, and `reconcileSettlements` re-derives rows.
 */
async function closeSettlementAsBroadcast(store: SettlementStore, txid: string): Promise<void> {
  try {
    await store.advanceSettlement(txid, ['admitted', 'submitting', 'held', 'handed_over'], 'broadcast')
  } catch (e) {
    devLog(`[processOfflineActions] could not close the settlement row of ${txid} as broadcast:`, e)
  }
}

/**
 * Post a foreign ancestor that arrived inside someone's BEEF.
 *
 * Only its own dependency closure is sent, not the whole merged graph, so each
 * transaction reaches the network in the order this engine chose rather than in
 * whatever order a service happens to unpack a batch.
 *
 * Services come from `storage.getServices()` rather than being passed in, so the
 * owned path — which calls `getServices()` itself inside the toolbox — and this
 * one cannot end up posting the same graph to two different sets of providers.
 */
async function postForeign(storage: StorageExpoSQLite, merged: Beef, txid: string): Promise<PostOutcome> {
  // Same witness as `postOwned`: an ancestor that arrived inside a counterparty's
  // BEEF was usually broadcast by that counterparty already, and a failed
  // re-post of it would block every owned transaction behind it. The
  // candidate rawTx for the proof check comes from the merged graph itself
  // (a counterparty's own bytes) rather than the network — absent only when
  // that entry is txid-only, in which case `networkAlreadyHas` degrades to
  // its pre-existing "no proof, no shortcut" answer.
  if (await networkAlreadyHas(storage, txid, merged.findTxid(txid)?.tx?.toBinary())) {
    devLog(`[processOfflineActions] the network already has foreign ancestor ${txid}; not posting`)
    return 'success'
  }
  try {
    const atomic = Beef.fromBinary(merged.toBinaryAtomic(txid))
    const results = await storage.getServices().postBeef(atomic, [txid])
    const outcome = outcomeOfForeignPost({ txid, results })
    devLog(`[processOfflineActions] posted foreign ancestor ${txid} => ${outcome}`)
    return outcome
  } catch (e) {
    devLog(`[processOfflineActions] posting foreign ancestor ${txid} threw, treating as retryable:`, e)
    return 'serviceError'
  }
}

/**
 * Record one rejection, and report whether anything local actually changed.
 *
 * Every read and every write is attempted independently, so one refusal costs only
 * the record it was for rather than the records after it —
 * `updateTransactionStatus` throws for an already-completed or proven transaction
 * (`StorageProvider.js:414-420`). What guarantees the cascade reaches the parent is
 * the caller's per-entry guard, not this function: unpacking the request entity can
 * still throw on corrupt stored JSON, and by then the child's failure has already
 * released the parent's outputs back to spendable.
 */
async function rejectOne(
  storage: StorageExpoSQLite,
  db: OfflineDb,
  row: OfflineActionRow | undefined,
  r: { txid: string; reason: string; poisonedByTxid: string }
): Promise<boolean> {
  let recorded = false
  const api = await findReq(storage, r.txid)
  if (api) {
    const req = new EntityProvenTxReq(api)
    // The attribution record: who handed us the poisoned transaction, over what
    // transport, and when. This is the only durable evidence the user will have.
    req.addHistoryNote({
      when: new Date().toISOString(),
      what: 'offlineRejected',
      poisonedBy: r.poisonedByTxid,
      reason: r.reason,
      senderIdentityKey: row?.senderIdentityKey ?? 'unknown',
      receivedVia: row?.receivedVia ?? 'unknown',
      receivedAt: row?.created_at ?? 'unknown'
    })
    req.status = 'invalid'
    try {
      await req.updateStorageDynamicProperties(storage)
      recorded = true
    } catch (e) {
      devLog(`[processOfflineActions] could not mark request ${r.txid} invalid:`, e)
    }
    for (const transactionId of req.notify.transactionIds ?? []) {
      try {
        // 'failed' releases allocated inputs and marks the outputs not spendable
        // (StorageProvider.js:421-424) — the money must stop being spendable.
        await storage.updateTransactionStatus('failed', transactionId)
        recorded = true
      } catch (e) {
        devLog(`[processOfflineActions] could not fail transaction ${transactionId} of ${r.txid}:`, e)
      }
    }
  }
  if (row) {
    try {
      await updateOfflineAction(db, r.txid, {
        status: 'rejected',
        rejectedReason: r.reason,
        poisonedByTxid: r.poisonedByTxid
      })
      recorded = true
    } catch (e) {
      devLog(`[processOfflineActions] could not mark the queue row of ${r.txid} rejected:`, e)
    }
  }
  devLog(`[processOfflineActions] rejected ${r.txid} (poisoned by ${r.poisonedByTxid}): ${r.reason}`)
  return recorded
}
