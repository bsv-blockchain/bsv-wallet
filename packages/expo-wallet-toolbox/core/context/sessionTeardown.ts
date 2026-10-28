/**
 * Session teardown registry. WalletContext owns the moments a wallet session
 * ends (logout, profile switch, network switch, same-wallet rebuild) but sits
 * above the pieces that hold live per-session state (the paired RPC relay, the
 * browser bridge). Those register here instead of WalletContext importing each.
 *
 * Plain module state, like the single-session handles it replaces: exactly one
 * wallet session exists per process.
 */

export type TeardownReason = 'logout' | 'profile' | 'network' | 'rebuild'

type TeardownFn = (reason: TeardownReason) => void

interface Entry {
  reasons: ReadonlySet<TeardownReason>
  fn: TeardownFn
}

const entries = new Set<Entry>()

/** Register `fn` for the given reasons. Returns an unregister function. */
export function registerSessionTeardown(reasons: TeardownReason[], fn: TeardownFn): () => void {
  const entry: Entry = { reasons: new Set(reasons), fn }
  entries.add(entry)
  return () => {
    entries.delete(entry)
  }
}

/**
 * Run every registered fn whose reasons include `reason`. Synchronous: callers
 * rely on teardown having happened before their next await. A throwing fn never
 * stops the others.
 */
export function runSessionTeardown(reason: TeardownReason): void {
  // Snapshot: a fn may unregister itself (or others) while running.
  for (const entry of [...entries]) {
    if (!entry.reasons.has(reason)) continue
    try {
      entry.fn(reason)
    } catch (e) {
      console.warn(`[sessionTeardown] ${reason} handler failed`, e)
    }
  }
}
