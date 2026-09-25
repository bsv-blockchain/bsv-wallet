/**
 * Pure gate for refreshProof's "not on chain → mark failed" path.
 * Offline-queued payments must not be failed: that releases inputs the
 * payee still holds and can double-spend the person we just paid.
 */

const IN_FLIGHT = new Set(['sending', 'unproven', 'nosend', 'unprocessed', 'unsigned', 'nonfinal'])

/** Matches the monitor's abandonedMsecs. */
const STUCK_AFTER_MS = 5 * 60 * 1000

export type OfflineRefreshStatus =
  | 'queued'
  | 'posting'
  | 'sent'
  | 'rejected'
  | 'acknowledged'
  // Held back deliberately, never released for broadcast. Like queued and
  // posting, a Refresh must not decide such a transaction has failed.
  | 'parked'

/**
 * refreshProof's /tx/hash/{txid} probe is advisory, single-source. Only an
 * authoritative 404 means the network doesn't have the tx; any other
 * completed non-OK response (429 rate-limit, 5xx, 401/403 auth trouble, ...)
 * is a service problem, not proof of absence, and must be treated as
 * inconclusive — exactly like a thrown network error.
 */
export function isChainAbsenceConfirmed(status: number): boolean {
  return status === 404
}

export function shouldFailUnprovenTx(args: {
  offlineStatus?: OfflineRefreshStatus
  txStatus: string
  updatedAtMs: number
  nowMs: number
}): 'pending' | 'failed' {
  if (args.offlineStatus === 'queued' || args.offlineStatus === 'posting' || args.offlineStatus === 'parked') {
    return 'pending'
  }
  if (!IN_FLIGHT.has(args.txStatus)) return 'pending'
  if (args.updatedAtMs && args.nowMs - args.updatedAtMs < STUCK_AFTER_MS) return 'pending'
  return 'failed'
}

/**
 * XR-059 remainder: refreshProof's two chain-service reads — the merkle BUMP
 * hex from WoC's /proof/bump, and the raw-tx hex fetched inside its
 * fetchRawTx callback — were unbounded, exactly like the address-sweep/BEEF
 * reads XR-059 already bounded in address.ts's parseWocBeefBody and
 * beefRepair.ts's refetchAtomicBeef. Same guard, same shape: a
 * compromised/misbehaving configured indexer must not be able to force an
 * arbitrarily large hex-decode (MerklePath.fromHex / Utils.toArray) just by
 * answering with more bytes than any real proof or raw tx ever carries.
 * Returns undefined for anything empty, oversized, odd-length, or not hex —
 * the caller fails closed exactly as it already does for an unparseable body.
 */
export function boundedHexResponse(text: string, maxChars: number): string | undefined {
  const hex = text.trim()
  if (hex.length === 0 || hex.length > maxChars || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return undefined
  }
  return hex
}
