/**
 * The transaction bytes a resend ships.
 *
 * Two sources, in this order:
 *
 *   NETWORK first, by txid. A mined transaction comes back with whatever proof
 *   is current, which is what repairs a merkle path staled by a reorg — the
 *   whole reason `refetchAtomicBeef` exists.
 *
 *   LOCAL storage second. A nearby payment whose code was never scanned was
 *   never broadcast: it is `nosend` and no service has heard of it, so the
 *   network answer is empty and the only copy is this device's. That is exactly
 *   the payment a resend is for, so falling back is not a nicety — without it
 *   the feature misses its main case. The payee internalizes and broadcasts it,
 *   which is the nearby rail's normal settlement path anyway.
 *
 * A local answer is held to the same structural bar as a fetched one: it must
 * parse, name this txid, and carry its ancestry. Anything less would hand the
 * payee bytes their wallet will reject, replacing one dead end with another.
 */
import { Beef } from '@bsv/sdk'

type BeefLike = { toBinary(): number[] }

export type LocalBeefStorage = {
  getValidBeefForKnownTxid(txid: string): Promise<BeefLike>
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
    const check = Beef.fromBinary(atomic)
    if (check.atomicTxid !== txid) return undefined
    if (!check.verifyValid(false).valid) return undefined
    return atomic
  } catch {
    return undefined
  }
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
    try {
      const local = await args.storage.getValidBeefForKnownTxid(txid)
      return atomicFromLocalBeef(local, txid)
    } catch {
      return undefined
    }
  }
}
