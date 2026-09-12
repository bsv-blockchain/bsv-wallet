import { VaultError } from './types'

/**
 * The YubiKey native modules expose one process-wide discovery/session object.
 * Every Vault path must therefore own this lease from before it subscribes or
 * starts discovery until after its final unsubscribe/stop. Queuing would keep
 * secrets and UI promises alive behind an unrelated operation, so contention
 * fails immediately and the caller can retry explicitly.
 */
let holder: symbol | null = null

export function acquireVaultHardwareLease(): () => void {
  if (holder) throw new VaultError('ceremony-active', 'Another Vault hardware operation is already active')
  const token = Symbol('vault-hardware-lease')
  holder = token
  let released = false
  return () => {
    if (released) return
    released = true
    if (holder === token) holder = null
  }
}
