/**
 * React bindings for demo mode.
 *
 * DEV-ONLY. Kept apart from `demoMode.ts` so that module stays importable from
 * plain (non-React) code, and so the only thing a screen has to reach for is a
 * hook that already re-renders when either the switch or the ledger moves.
 */
import { useSyncExternalStore } from 'react'
import { isDemoModeEnabled, subscribeDemoMode } from './demoMode'
import { subscribeDemoLedger } from './demoLedger'
import { createDemoMandalaRuntime } from './demoMandalaRuntime'
import type { MandalaRuntime } from '../mandala/runtime'

/** One runtime for the session: its data is read through the ledger anyway. */
let runtime: MandalaRuntime | null = null
function demoRuntime(): MandalaRuntime {
  if (!runtime) runtime = createDemoMandalaRuntime()
  return runtime
}

/** Re-renders on the switch only. */
export function useDemoMode(): boolean {
  return useSyncExternalStore(subscribeDemoMode, isDemoModeEnabled, () => false)
}

/**
 * Re-renders on the switch AND on every ledger write, so a screen reading
 * figures straight out of the ledger repaints when a demo payment lands.
 */
export function useDemoLedgerVersion(): number {
  return useSyncExternalStore(
    listener => {
      const offMode = subscribeDemoMode(listener)
      const offLedger = subscribeDemoLedger(listener)
      return () => {
        offMode()
        offLedger()
      }
    },
    () => version,
    () => 0
  )
}

// `useSyncExternalStore` compares snapshots by identity, so the ledger needs a
// changing primitive to report rather than a fresh object each call.
let version = 0
subscribeDemoLedger(() => {
  version += 1
})
subscribeDemoMode(() => {
  version += 1
})

/** The demo runtime when the switch is on, otherwise null. */
export function useDemoMandalaRuntime(): MandalaRuntime | null {
  const on = useDemoMode()
  return on ? demoRuntime() : null
}
