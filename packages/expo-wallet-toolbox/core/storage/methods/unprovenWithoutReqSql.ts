/**
 * Transactions nothing will ever prove on its own: `unproven`, with no
 * proven_tx_req for TaskCheckForProofs to work from and no proven_tx already
 * recorded. Left behind when an `internalizeAction` fails after inserting the
 * transaction row and its retry takes the toolbox's merge path, which creates
 * no req. The wallet repairs these itself with `recordProof` (see pay/).
 */
import type { OfflineDb } from './offlineActions'

export const UNPROVEN_TXIDS_WITHOUT_REQ_SQL = `
  SELECT DISTINCT t.txid AS txid
    FROM transactions t
   WHERE t.status = 'unproven'
     AND t.txid IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM proven_tx_reqs r WHERE r.txid = t.txid)
     AND NOT EXISTS (SELECT 1 FROM proven_txs p WHERE p.txid = t.txid)
   ORDER BY t.txid
`

/** Same shape (and same reasoning about `params`) as `OfflineDb` in ./offlineActions. */
export type UnprovenQueryDb = Pick<OfflineDb, 'getAllAsync'>

export async function findUnprovenTxidsWithoutReq(db: UnprovenQueryDb): Promise<string[]> {
  const rows = (await db.getAllAsync(UNPROVEN_TXIDS_WITHOUT_REQ_SQL, [])) as { txid: string }[]
  return rows.map(r => r.txid)
}
