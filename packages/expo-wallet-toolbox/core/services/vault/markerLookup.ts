/**
 * One chain lookup with three results (hardening constraints 1 and 5).
 *
 * Salt allocation, the chain scan and the reset gate all ask the same
 * question: "does this marker script have any history?". The answer is found,
 * none or unknown. "unknown" (lookup failed, rate limit, truncated window)
 * must fail closed: callers never read it as "no funds" and never allow a
 * salt index on it.
 */
import type { AppChain } from '../../config'
import { wocChainLookup } from './wocLookup'

/** Smallest Vault output a scan will internalize. Frozen at the value that
 * applied when the first v7 marker was committed (every v7 output was created
 * under it). It never follows VAULT_DEPOSIT_MIN downward: lowering the
 * deposit floor requires a new scan rule. */
export const VAULT_SCAN_MIN_SATS = 100_000

export type MarkerUnknownReason = 'request-failed' | 'rate-limited' | 'malformed' | 'window-full'

export type MarkerHistory =
  | { status: 'none' }
  | { status: 'found'; txids: string[] }
  /** txids = rows read before the problem, may be empty. */
  | { status: 'unknown'; reason: MarkerUnknownReason; txids: string[] }

/**
 * Injected chain lookup: the only network/indexer dependency of the scan.
 * Unit-tested against an in-memory fake; wocLookup.ts is the production
 * WhatsOnChain implementation.
 */
export interface VaultChainLookup {
  /** Every txid whose output list includes an output with exactly this
   * locking script, from address history and/or the current unspent set.
   * An empty result is a genuine "no marker at this index" miss. Legacy
   * contract, unchanged. */
  transactionsForLockingScript(lockingScriptHex: string): Promise<string[]>
  /** AtomicBEEF-decodable bytes for `txid` (a plain raw-tx-only BEEF is
   * fine: recoverOneCandidate only reads `tx.outputs` from it locally; the
   * bytes handed to `wallet.internalizeAction` are these same bytes, and ITS
   * OWN chain-tracker validation is the actual SPV gate), plus whether this
   * lookup can currently show the transaction as confirmed. `null` means the
   * lookup could not produce usable bytes at all (reported as a problem, not
   * a miss). `confirmed: false` is the explicit zero-conf boundary:
   * recoverOneCandidate reports it as `pendingConfirmation` rather than
   * attempting `internalizeAction`. */
  transactionForTxid(txid: string): Promise<{ beef: number[]; confirmed: boolean } | null>
  /** Spent/unspent/unknown for one outpoint. 'unknown' is never trusted as
   * unspent. */
  outputStatus(outpoint: { txid: string; vout: number }): Promise<'unspent' | 'spent' | 'unknown'>
  /** One lookup, three results. Optional so existing fakes keep working. */
  markerHistory?(lockingScriptHex: string): Promise<MarkerHistory>
  /** Base58 address of a P2PKH marker script, for display. */
  markerAddress?(lockingScriptHex: string): string | undefined
}

/** Ask the one question. Uses `markerHistory` when the lookup has it, else
 * falls back to the legacy `transactionsForLockingScript`: a throw is
 * unknown, an empty list is none, rows are found. */
export async function lookupMarker(lookup: VaultChainLookup, lockingScriptHex: string): Promise<MarkerHistory> {
  if (lookup.markerHistory) return lookup.markerHistory(lockingScriptHex)
  let txids: string[]
  try {
    txids = await lookup.transactionsForLockingScript(lockingScriptHex)
  } catch {
    return { status: 'unknown', reason: 'request-failed', txids: [] }
  }
  return txids.length === 0 ? { status: 'none' } : { status: 'found', txids }
}

let injectedLookup: VaultChainLookup | null = null

/** Test seam. A no-op outside __DEV__ (same gate as setMockDriver), so a
 * release build can never swap the chain lookup. */
export function setVaultChainLookup(lookup: VaultChainLookup | null): void {
  if (!__DEV__) return
  injectedLookup = lookup
}

/** The injected lookup, else WhatsOnChain. `wocChainLookup` throws for a
 * chain without WhatsOnChain, so a misrouted call fails closed. */
export function getVaultChainLookup(chain: AppChain): VaultChainLookup {
  return injectedLookup ?? wocChainLookup(chain)
}

const saltFloors = new Map<string, number>()

/** In-memory hint: the highest salt index already used for `storageKey` in
 * this session. It only raises. */
export function noteSaltFloor(storageKey: string, index: number): void {
  if (index > (saltFloors.get(storageKey) ?? 0)) saltFloors.set(storageKey, index)
}

/** 0 when unset. */
export function saltFloorFor(storageKey: string): number {
  return saltFloors.get(storageKey) ?? 0
}
