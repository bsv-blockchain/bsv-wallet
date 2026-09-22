/**
 * The demo-mode switch, and the only thing outside this folder that decides
 * whether any of it is live.
 *
 * DEV-ONLY, enforced twice over: `setDemoModeEnabled` refuses to latch on in a
 * release bundle even if a release caller reaches it directly, and every call
 * site behind it is itself wrapped in `__DEV__` so this module is never
 * required into a production bundle at all. Same belt-and-braces shape as
 * `core/services/vault/devMock.ts`.
 *
 * Deliberately NOT persisted. Demo mode is something you switch on to show
 * someone the app and switch off again; a flag that survived a restart is a
 * flag that is eventually on when nobody meant it to be.
 */
const listeners = new Set<() => void>()
let enabled = false

export function isDemoModeEnabled(): boolean {
  return __DEV__ && enabled
}

export function setDemoModeEnabled(on: boolean): void {
  // A release caller can never turn this on, whatever it passes.
  if (!__DEV__) {
    enabled = false
    return
  }
  if (enabled === on) return
  enabled = on
  listeners.forEach(l => l())
}

export function subscribeDemoMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
