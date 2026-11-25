/**
 * Ask the network (never Arcade) whether it knows a txid. Used by the paymail
 * rail to decide if a receiver that answered with an error still got the
 * payment. Every call has a deadline so a hung status service cannot stall the
 * send, the retry or the outbox drain.
 */

export type StatusFn = (
  txids: string[]
) => Promise<{ status?: string; results?: { txid: string; status: string }[] }>

export type NetworkVerdict = 'known' | 'unknown' | 'error'

export const NETWORK_CALL_DEADLINE_MS = 10_000

/** Reject with `Error('deadline')` if `work` has not settled after `ms`. */
export function withDeadline<T>(work: Promise<T>, ms: number = NETWORK_CALL_DEADLINE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('deadline')), ms)
    work.then(
      v => {
        clearTimeout(timer)
        resolve(v)
      },
      e => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** Status function backed by the storage's services (same source as `verifyDeclinedAborts`). */
export function statusFnFromStorage(storage: { getServices(): unknown }): StatusFn {
  return async txids => {
    const services = storage.getServices() as { getStatusForTxids?: StatusFn }
    if (typeof services?.getStatusForTxids !== 'function') throw new Error('status_unavailable')
    return services.getStatusForTxids(txids)
  }
}

export async function networkKnowsTxid(
  getStatusForTxids: StatusFn,
  txid: string,
  deadlineMs: number = NETWORK_CALL_DEADLINE_MS
): Promise<NetworkVerdict> {
  try {
    const res = await withDeadline(Promise.resolve().then(() => getStatusForTxids([txid])), deadlineMs)
    if (res == null || res.status === 'error' || !Array.isArray(res.results)) return 'error'
    const want = txid.toLowerCase()
    const row = res.results.find(r => typeof r?.txid === 'string' && r.txid.toLowerCase() === want)
    return row != null && (row.status === 'mined' || row.status === 'known') ? 'known' : 'unknown'
  } catch {
    return 'error'
  }
}
