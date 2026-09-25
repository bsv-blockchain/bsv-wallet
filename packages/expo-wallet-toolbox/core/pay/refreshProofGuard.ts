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
  // Written only by a raw database import (ui/importDatabases.ts) over a
  // copied-in 'queued'/'posting' row (XR-085): still an unresolved, possibly
  // already-handed-off spend awaiting the user's renewed review, so it must
  // not be failed either — same reasoning as 'parked'.
  | 'import_hold'

export function shouldFailUnprovenTx(args: {
  offlineStatus?: OfflineRefreshStatus
  txStatus: string
  updatedAtMs: number
  nowMs: number
}): 'pending' | 'failed' {
  if (
    args.offlineStatus === 'queued' ||
    args.offlineStatus === 'posting' ||
    args.offlineStatus === 'parked' ||
    args.offlineStatus === 'import_hold'
  ) {
    return 'pending'
  }
  if (!IN_FLIGHT.has(args.txStatus)) return 'pending'
  if (args.updatedAtMs && args.nowMs - args.updatedAtMs < STUCK_AFTER_MS) return 'pending'
  return 'failed'
}
