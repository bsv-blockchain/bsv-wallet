/**
 * The transaction bytes a resend ships.
 *
 * Three sources, in this order:
 *
 *   NETWORK first, by txid. A mined transaction comes back with whatever proof
 *   is current, which is what repairs a merkle path staled by a reorg — the
 *   reason `refetchAtomicBeef` exists.
 *
 *   STORAGE second, assembled with ancestry (`getBeefForTransaction`), then the
 *   plain known-txid lookup, then the transaction's OWN stored bytes. A nearby payment whose code was never scanned was
 *   never broadcast: it is `nosend`, no service has heard of it, and the only
 *   copy is this device's. That is exactly the payment a resend is for, so a
 *   local source is not a nicety — without it the feature misses its main case.
 *   The payee internalizes and broadcasts, which is the nearby rail's normal
 *   settlement path anyway.
 *
 *   The third source exists because the first two can BOTH fail on a payment
 *   this device holds in full. Each walks the input chain by asking storage for
 *   every ancestor txid in turn (`getValidBeefForKnownTxid`, which throws on the
 *   first one it does not hold) — so one ancestor that only ever existed inside
 *   a stored `inputBEEF`, never as its own row, fails the whole assembly. But
 *   `transactions.inputBEEF` is precisely the ancestry `createAction` captured
 *   and validated when it built this payment: rawTx plus that column is a
 *   complete, self-contained answer, with no walk and no service call.
 *
 * What the bar is, and is not: the bytes must parse, name this txid, and carry
 * their ancestry (`toAtomicBEEF` throws when an input has no source
 * transaction) — enough that the payee's wallet is not handed something it will
 * refuse. It deliberately does NOT require a verified merkle proof. A
 * never-broadcast transaction has none by construction, so demanding one
 * rejected precisely the payment this path exists to rescue, and reported it as
 * "couldn't get this payment's data" to someone who was online the whole time.
 * The receiving wallet validates independently, as it does for any payment.
 */
import { Beef } from '@bsv/sdk'

type BeefLike = { toBinary(): number[] }

export type LocalBeefStorage = {
  getValidBeefForKnownTxid?(txid: string): Promise<BeefLike>
  getBeefForTransaction?(txid: string, options: Record<string, unknown>): Promise<BeefLike>
  findTransactions?(args: {
    partial: { txid: string }
  }): Promise<{ rawTx?: number[] | Uint8Array | null; inputBEEF?: number[] | Uint8Array | null }[]>
}

/** AtomicBEEF for `txid` from a local Beef, or undefined if it cannot be made. */
export function atomicFromLocalBeef(beef: BeefLike, txid: string): number[] | undefined {
  try {
    const parsed = Beef.fromBinary(beef.toBinary())
    const tx = parsed.findAtomicTransaction(txid)
    if (!tx) return undefined
    // Throws rather than emitting a partial beef when an input has no source
    // transaction — the ancestry gap we must not hand onward.
    const atomic = tx.toAtomicBEEF()
    if (Beef.fromBinary(atomic).atomicTxid !== txid) return undefined
    return atomic
  } catch {
    return undefined
  }
}

/** The transaction's own row: its rawTx merged onto the ancestry createAction
 * stored with it. No ancestor walk, so nothing to fail to find. */
async function fromStoredTx(storage: LocalBeefStorage, txid: string): Promise<number[] | undefined> {
  try {
    const rows = (await storage.findTransactions?.({ partial: { txid } })) ?? []
    const row = rows[0]
    if (!row?.rawTx) return undefined
    const beef = row.inputBEEF ? Beef.fromBinary(Array.from(row.inputBEEF)) : new Beef()
    beef.mergeRawTx(Array.from(row.rawTx))
    return atomicFromLocalBeef(beef, txid)
  } catch {
    return undefined
  }
}

async function fromStorage(storage: LocalBeefStorage, txid: string): Promise<number[] | undefined> {
  // Ancestry-assembling lookup first: it merges input beefs (and reaches for
  // services when storage is short a link), which is what makes toAtomicBEEF
  // able to emit a self-contained proof for an unbroadcast transaction.
  for (const read of [
    async () => await storage.getBeefForTransaction?.(txid, {}),
    async () => await storage.getValidBeefForKnownTxid?.(txid)
  ]) {
    try {
      const beef = await read()
      if (!beef) continue
      const atomic = atomicFromLocalBeef(beef, txid)
      if (atomic) return atomic
    } catch (e) {
      // Either lookup throws for a txid it does not hold. Try the next — but
      // say which one gave up, because "couldn't get this payment's data" on a
      // payment this device built is otherwise unattributable from a log.
      console.warn('[resend] local beef lookup failed:', e instanceof Error ? e.message : e)
    }
  }
  return await fromStoredTx(storage, txid)
}

export function makeResendBeef(args: {
  /** Network lookup by txid — `makeBeefRepair` in production. */
  refetch: (txid: string) => Promise<number[] | undefined>
  storage?: LocalBeefStorage | null
}): (txid: string) => Promise<number[] | undefined> {
  return async (txid: string) => {
    const fetched = await args.refetch(txid).catch(() => undefined)
    if (fetched) return fetched
    if (!args.storage) return undefined
    const local = await fromStorage(args.storage, txid)
    if (!local) console.warn(`[resend] no usable transaction bytes for ${txid}, from the network or this device`)
    return local
  }
}
