/**
 * Durable retry list for `abortAction` calls that failed after a decline.
 *
 * A failed abort is a stuck UTXO, not a lost payment. The decline still
 * stands; the reference is retried on the next wallet build.
 */
interface StorageLike {
  getKeyValue: (key: string) => Promise<string | undefined>
  setKeyValue: (key: string, value: string) => Promise<void>
}

export const PENDING_ABORTS_KEY = 'pending_aborts'

export interface PendingAbort {
  reference: string
  originator: string
}

export async function loadPendingAborts(storage: StorageLike): Promise<PendingAbort[]> {
  try {
    const raw = await storage.getKeyValue(PENDING_ABORTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: PendingAbort[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const reference = (item as { reference?: unknown }).reference
      const originator = (item as { originator?: unknown }).originator
      if (typeof reference === 'string' && reference && typeof originator === 'string') {
        out.push({ reference, originator })
      }
    }
    return out
  } catch {
    return []
  }
}

export async function queuePendingAbort(storage: StorageLike, item: PendingAbort): Promise<void> {
  if (!item.reference) return
  const all = await loadPendingAborts(storage)
  if (all.some(a => a.reference === item.reference)) return
  await storage.setKeyValue(PENDING_ABORTS_KEY, JSON.stringify([...all, item]))
}

export async function replayPendingAborts(args: {
  wallet: {
    abortAction: (args: { reference: string }, originator?: string) => Promise<{ aborted?: boolean } | void>
  }
  storage: StorageLike
}): Promise<void> {
  const pending = await loadPendingAborts(args.storage)
  if (pending.length === 0) return
  const kept: PendingAbort[] = []
  for (const item of pending) {
    try {
      const result = await args.wallet.abortAction({ reference: item.reference }, item.originator)
      if (result && typeof result === 'object' && result.aborted === false) {
        kept.push(item)
      }
    } catch {
      kept.push(item)
    }
  }
  await args.storage.setKeyValue(PENDING_ABORTS_KEY, JSON.stringify(kept))
}
