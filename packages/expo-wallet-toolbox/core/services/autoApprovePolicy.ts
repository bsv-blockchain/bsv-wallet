/**
 * Auto-approve accounting for spendingAuthorizationCallback (misc-p2-04,
 * MITM-P1-hijacked-sessions-unprompted's spending-accounting half).
 *
 * Previously a single module-level `lastAutoApproveTime` gated EVERY
 * originator with one global cooldown and no cumulative total — so multiple
 * paired origins accidentally throttled each other, while a single origin
 * alone could still auto-approve up to the per-request threshold every
 * cooldown window forever (≈0.0864 BSV/day at the shipped defaults). This
 * module replaces that with: a per-originator cooldown (so origins no
 * longer throttle each other) PLUS a global rolling 24h cumulative cap
 * across every originator (so no single origin, or combination of
 * originators, can auto-approve an unbounded total). A ledger entry records
 * every APPROVED auto-approval so the cap can be computed and pruned.
 *
 * Pure and dependency-injected (no AsyncStorage, no Date.now()) so it can be
 * unit tested deterministically; the caller (WalletContext) owns wiring the
 * ledger to persistent storage.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export type AutoApproveReason = 'over-threshold' | 'cooldown' | 'daily-cap' | null

export interface AutoApproveDecision {
  approve: boolean
  reason: AutoApproveReason
}

export interface AutoApproveLedgerEntry {
  originator: string
  satoshis: number
  at: number
}

export interface AutoApprovePolicyDeps {
  /** Current time, ms since epoch. Injected so tests can control the clock. */
  now: () => number
  /** Read fresh on every decision, matching the existing threshold-read-per-request behaviour. */
  threshold: () => number
  /** Minimum ms between two auto-approvals for the SAME originator. */
  cooldownMs: number
  /** Global rolling-24h cumulative cap on auto-approved satoshis, across every originator. */
  dailyCapSats: number
}

export interface AutoApprovePolicy {
  /** Decide whether to auto-approve, WITHOUT recording anything. */
  shouldAutoApprove(args: { originator: string; satoshis: number }): AutoApproveDecision
  /** Record an approval that was actually granted (call only when `shouldAutoApprove` said yes). */
  record(args: { originator: string; satoshis: number; at: number }): void
  /** Snapshot of the current (already-pruned as of last access) ledger, for persistence. */
  getLedger(): AutoApproveLedgerEntry[]
  /** Restore a ledger previously returned by `getLedger`, e.g. from AsyncStorage at startup. */
  loadLedger(entries: AutoApproveLedgerEntry[]): void
}

export function createAutoApprovePolicy(deps: AutoApprovePolicyDeps): AutoApprovePolicy {
  const lastApproveAtByOriginator = new Map<string, number>()
  let ledger: AutoApproveLedgerEntry[] = []

  function pruneLedger(now: number): void {
    ledger = ledger.filter(entry => now - entry.at < DAY_MS)
  }

  function dailyTotal(now: number): number {
    pruneLedger(now)
    return ledger.reduce((sum, entry) => sum + entry.satoshis, 0)
  }

  return {
    shouldAutoApprove({ originator, satoshis }) {
      const threshold = deps.threshold()
      if (!(threshold > 0) || satoshis > threshold) {
        return { approve: false, reason: 'over-threshold' }
      }

      const now = deps.now()
      const lastApproveAt = lastApproveAtByOriginator.get(originator) ?? 0
      if (now - lastApproveAt < deps.cooldownMs) {
        return { approve: false, reason: 'cooldown' }
      }

      if (dailyTotal(now) + satoshis > deps.dailyCapSats) {
        return { approve: false, reason: 'daily-cap' }
      }

      return { approve: true, reason: null }
    },

    record({ originator, satoshis, at }) {
      lastApproveAtByOriginator.set(originator, at)
      ledger.push({ originator, satoshis, at })
      pruneLedger(at)
    },

    getLedger() {
      return ledger.slice()
    },

    loadLedger(entries) {
      ledger = entries.slice()
    }
  }
}
