/**
 * Which `invalid` proof requests are still worth another lookup.
 *
 * The app patches TaskUnFail to re-examine `invalid` reqs, because the library
 * only ever looks at `unfail` and nothing promotes one to the other — so a
 * transaction invalidated by a service outage (a WoC 401, chaintracks down)
 * would stay invalid for good. That patch was unbounded: it took every invalid
 * req on every pass, forever.
 *
 * Two things make it terminate.
 *
 * The transaction is already resolved. `reviewStatus` fails the transaction
 * behind an invalid req and releases its inputs; once that has happened there
 * is nothing left for a merkle path to rescue, and asking the network for one
 * every ten minutes is pure noise — which is exactly how this surfaced, as the
 * same three txids reporting "returned to status 'invalid'" forever.
 *
 * It has been asked enough times. The library's failure path does not touch
 * `attempts` (only its success path does, resetting them), so nothing aged out
 * on its own. Counting failures here gives a genuinely unmineable transaction
 * somewhere to stop.
 */

/** Consecutive failed proof lookups before an invalid req is left alone. */
export const MAX_UNFAIL_RETRIES = 6

export type InvalidReq = { provenTxReqId: number; txid: string; attempts?: number | null }

/** Transaction statuses per txid, as the transactions table holds them. */
export type TxStatusesByTxid = Map<string, string[]>

/**
 * A txid whose every transaction row is terminal has nothing to recover. No row
 * at all counts as resolved too: the req outlived whatever referenced it.
 */
export function isResolved(statuses: string[] | undefined): boolean {
  if (!statuses || statuses.length === 0) return true
  return statuses.every(s => s === 'failed' || s === 'completed')
}

export function selectRetryableInvalidReqs<T extends InvalidReq>(reqs: T[], statuses: TxStatusesByTxid): T[] {
  return reqs.filter(r => !isResolved(statuses.get(r.txid)) && (r.attempts ?? 0) < MAX_UNFAIL_RETRIES)
}
