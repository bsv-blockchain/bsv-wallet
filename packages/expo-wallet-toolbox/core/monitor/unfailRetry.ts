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

/**
 * The two storage surfaces this needs, named apart on purpose.
 *
 * A monitor task's `storage` is the WalletStorageManager, which exposes only a
 * narrow slice: `findProvenTxReqs` is there, `findTransactions` and
 * `updateProvenTxReq` are not. Reaching for one of the missing ones threw at
 * runtime and took the whole UnFail task down with it — including the
 * library's own handling. Declaring both surfaces means the compiler now
 * refuses that mistake instead of the device finding it.
 */
export interface UnfailProvider {
  findTransactions(args: { partial: { txid: string }; noRawTx?: boolean }): Promise<{ status: string }[]>
  updateProvenTxReq(id: number, update: { attempts: number }): Promise<unknown>
}

export interface UnfailStorage {
  findProvenTxReqs(args: {
    partial: Record<string, unknown>
    status: string[]
    paged: { limit: number; offset: number }
  }): Promise<InvalidReq[]>
  runAsStorageProvider<T>(fn: (sp: UnfailProvider) => Promise<T>): Promise<T>
}

const PAGE = { limit: 100, offset: 0 }

/**
 * One bounded pass over the `invalid` reqs, returning what to append to the
 * task's log. Empty when there was nothing worth asking about — which, once a
 * wallet's dead transactions have been failed, is every pass.
 */
export async function runBoundedUnfail(args: {
  storage: UnfailStorage
  unfail: (reqs: InvalidReq[], indent: number) => Promise<{ log: string }>
}): Promise<string> {
  const { storage, unfail } = args
  const invalidReqs = await storage.findProvenTxReqs({ partial: {}, status: ['invalid'], paged: PAGE })
  if (invalidReqs.length === 0) return ''

  const byTxid = await storage.runAsStorageProvider(async sp => {
    const map: TxStatusesByTxid = new Map()
    for (const req of invalidReqs) {
      if (map.has(req.txid)) continue
      const rows = await sp.findTransactions({ partial: { txid: req.txid }, noRawTx: true })
      map.set(
        req.txid,
        rows.map(r => r.status)
      )
    }
    return map
  })

  const retryable = selectRetryableInvalidReqs(invalidReqs, byTxid)
  if (retryable.length === 0) return ''

  let log = `\n${retryable.length} invalid reqs — retrying proof lookup\n`
  log += (await unfail(retryable, 2)).log

  // The library's failure path leaves `attempts` untouched (only its success
  // path writes it, resetting to 0), so without this nothing ages out and the
  // bound could never be reached.
  const stillInvalid = await storage.findProvenTxReqs({ partial: {}, status: ['invalid'], paged: PAGE })
  const stillById = new Map(stillInvalid.map(q => [q.provenTxReqId, q]))
  await storage.runAsStorageProvider(async sp => {
    for (const req of retryable) {
      const current = stillById.get(req.provenTxReqId)
      if (!current) continue
      await sp.updateProvenTxReq(req.provenTxReqId, { attempts: (current.attempts ?? 0) + 1 })
    }
  })
  return log
}
