import {
  REVIEW_REQ_STATUSES_SQL,
  collectFailedTransactionIds,
  type ReviewFailedTx
} from '../storage/methods/reviewStatusSql'

export type ReleaseStuckDb = {
  getAllAsync(sql: string, params?: unknown[]): Promise<unknown[]>
  runAsync(sql: string, params?: unknown[]): Promise<unknown>
}

type StuckRow = { outputId: number; satoshis: number; txid: string; failedTransactionId: number }

const STUCK_RESERVATIONS_SQL = `
  SELECT o.outputId AS outputId, o.satoshis AS satoshis, t.txid AS txid, t.transactionId AS failedTransactionId
    FROM outputs o JOIN transactions t ON t.transactionId = o.spentBy
   WHERE t.status = 'failed'
`.trim()

/**
 * A FAILED transaction never confirms, but the toolbox leaves the inputs it
 * had reserved marked `spentBy` that dead txid — so the coin reads as an
 * unresolvable double-spend forever (WERR_REVIEW_ACTIONS on every new spend,
 * even though the output is still `spendable`). Null out spentBy and restore
 * spendable for every output still reserved by a failed tx.
 *
 * XR-032: the local `status = 'failed'` alone is not proof the reservation is
 * safe to release — the same status is left behind by a transaction that was
 * actually broadcast/delivered (a stale/imported row, or an interrupted
 * send), and resurrecting its inputs lets the wallet build a conflicting
 * second payment from already-spent coins. Reuse the exact proven_tx_reqs
 * gate `StorageExpoSQLite.reviewStatus`/`reviewStatusOnDb` already apply
 * before restoring an input: only release a reservation when every
 * proven_tx_req row for the spender's txid (if any) is itself a terminal,
 * safe-to-discard status (invalid/doubleSpend). Pure local SQL — no network.
 */
export async function releaseStuckReservationsOnDb(db: ReleaseStuckDb): Promise<string> {
  const rows = (await db.getAllAsync(STUCK_RESERVATIONS_SQL)) as StuckRow[]
  if (!rows || rows.length === 0) return 'No stuck reservations found.'

  const failedTxs: ReviewFailedTx[] = []
  const seen = new Set<number>()
  for (const row of rows) {
    if (seen.has(row.failedTransactionId)) continue
    seen.add(row.failedTransactionId)
    failedTxs.push({ transactionId: row.failedTransactionId, txid: row.txid })
  }

  const reqStatusesByTxid = new Map<string, string[]>()
  for (const tx of failedTxs) {
    if (!tx.txid || reqStatusesByTxid.has(tx.txid)) continue
    const reqs = (await db.getAllAsync(REVIEW_REQ_STATUSES_SQL, [tx.txid])) as { status: string }[]
    reqStatusesByTxid.set(
      tx.txid,
      reqs.map(r => r.status)
    )
  }

  const { safeFailedTransactionIds } = collectFailedTransactionIds(failedTxs, reqStatusesByTxid, new Set())
  const safeRows = rows.filter(row => safeFailedTransactionIds.has(row.failedTransactionId))
  if (safeRows.length === 0) return 'No stuck reservations found.'

  const placeholders = safeRows.map(() => '?').join(',')
  await db.runAsync(
    `UPDATE outputs SET spentBy = NULL, spendable = 1 WHERE outputId IN (${placeholders})`,
    safeRows.map(r => r.outputId)
  )
  const detail = safeRows
    .map(r => `  • ${r.satoshis} sat (output ${r.outputId}) ← failed ${String(r.txid).slice(0, 12)}…`)
    .join('\n')
  return `✓ Released ${safeRows.length} stuck reservation(s):\n${detail}`
}
