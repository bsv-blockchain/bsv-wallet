/**
 * Whether TaskSendWaiting must skip a request this pass because one of its
 * inputs is still sitting in the offline queue.
 *
 * A child posted ahead of a queued parent is refused as an orphan. The drain
 * (`TaskSendOffline`) owns parent-first release; this predicate only parks the
 * child and asks the drain to run.
 */
import { Transaction } from '@bsv/sdk'

export function shouldDeferSendWaiting(inputTxids: string[], queuedTxids: Set<string>): boolean {
  return inputTxids.some(id => queuedTxids.has(id))
}

/** Input txids of a stored raw transaction, or [] if the bytes will not parse. */
export function inputTxidsFromRawTx(rawTx: number[] | Uint8Array | undefined): string[] {
  if (rawTx == null) return []
  try {
    const tx = Transaction.fromBinary(Array.from(rawTx))
    const ids: string[] = []
    for (const input of tx.inputs) {
      const id = input.sourceTXID
      if (typeof id === 'string' && id.length > 0) ids.push(id)
    }
    return ids
  } catch {
    return []
  }
}
