import { VaultError } from './types'

/**
 * The YubiKey native modules expose one process-wide discovery/session object.
 * Every Vault path must therefore own this lease from before it subscribes or
 * starts discovery until after its final unsubscribe/stop. Queuing would keep
 * secrets and UI promises alive behind an unrelated operation, so contention
 * fails immediately and the caller can retry explicitly.
 */
let holder: symbol | null = null

/** XR-004: bumped by every successful acquireVaultHardwareLease() call. The
 * JS-visible timeout/detach race in session.ts's withKeySession can settle —
 * and free this lease — while the real work() promise it raced is still
 * pending: the native calls it wraps cannot be cancelled. A caller that
 * captured its own generation right after acquiring can later ask
 * isCurrentVaultHardwareGeneration whether a NEWER session has since been
 * acquired, i.e. whether its own continuation has been abandoned and
 * superseded — and refuse its next mutation instead of racing a retry. */
let generation = 0

export function currentVaultHardwareGeneration(): number {
  return generation
}

export function isCurrentVaultHardwareGeneration(capturedGeneration: number): boolean {
  return capturedGeneration === generation
}

export function acquireVaultHardwareLease(): () => void {
  if (holder) throw new VaultError('ceremony-active', 'Another Vault hardware operation is already active')
  const token = Symbol('vault-hardware-lease')
  holder = token
  generation++
  let released = false
  return () => {
    if (released) return
    released = true
    if (holder === token) holder = null
  }
}
