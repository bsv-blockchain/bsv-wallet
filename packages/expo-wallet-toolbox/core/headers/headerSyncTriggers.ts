/**
 * When the local header window is topped up.
 *
 * An offline payee can only verify a nearby payment whose ancestry bottoms out
 * at a block it already holds a header for, so the window has to keep up with
 * the chain while the device has signal — not only at wallet build. Reconnects
 * alone are not enough: a phone that stays on one Wi-Fi network never sees
 * one, and on iOS NetInfo delivers nothing while the app is suspended, so a
 * phone brought back to the foreground may not either.
 *
 * So a sync is attempted on each of:
 *  · coming online (every NetInfo event that reads online),
 *  · returning to the foreground,
 *  · a fixed interval while the app runs.
 *
 * Each attempt is gated on `isOnline()` and is cheap when there is nothing to
 * do: `syncHeaders` asks for the present height and fetches only the headers
 * above the local tip (one or two per ten minutes on mainnet). Overlap is the
 * caller's `sync` to prevent (WalletContext's `runHeaderSync` single-flights).
 */

/** One block's worth of time: the window never trails the tip by more than about one block while online. */
export const HEADER_SYNC_INTERVAL_MS = 10 * 60 * 1000

export interface HeaderSyncTriggerDeps {
  /** Runs one sync pass. Must not throw into the caller; rejections are swallowed here anyway. */
  sync: () => Promise<unknown>
  isOnline: () => Promise<boolean>
  subscribeOnline: (cb: (online: boolean) => void) => () => void
  subscribeForeground: (cb: () => void) => () => void
  intervalMs?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

/** Starts every trigger; returns the function that stops them all. */
export function startHeaderSyncTriggers(deps: HeaderSyncTriggerDeps): () => void {
  const schedule = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const cancel = deps.clearInterval ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>))
  let stopped = false

  const attempt = async (knownOnline: boolean) => {
    if (stopped) return
    try {
      if (!knownOnline && !(await deps.isOnline())) return
      if (stopped) return
      await deps.sync()
    } catch {
      // Best-effort. The next trigger retries.
    }
  }

  const unsubscribeOnline = deps.subscribeOnline(online => {
    if (online) void attempt(true)
  })
  const unsubscribeForeground = deps.subscribeForeground(() => void attempt(false))
  const interval = schedule(() => void attempt(false), deps.intervalMs ?? HEADER_SYNC_INTERVAL_MS)

  return () => {
    stopped = true
    unsubscribeOnline()
    unsubscribeForeground()
    cancel(interval)
  }
}
