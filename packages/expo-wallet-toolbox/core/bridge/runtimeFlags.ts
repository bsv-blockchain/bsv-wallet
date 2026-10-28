/**
 * Whether any registered bridge transport can deliver `unattested` calls (spec 6.5).
 *
 * The wallet build creates the unverified permissions manager only when this is true, and
 * rebuilds its managers when it turns true. Kept in its own dependency-free module so the
 * runtime (which sets it) and WalletContext (which reads it) need not import each other.
 */

let present = false
const listeners = new Set<(present: boolean) => void>()

export function setUnattestedTransportPresent(v: boolean): void {
  if (present === v) return
  present = v
  for (const fn of [...listeners]) {
    try {
      fn(v)
    } catch {
      // A listener must not stop the others.
    }
  }
}

export function hasUnattestedTransport(): boolean {
  return present
}

/** Returns the unsubscribe function. */
export function onUnattestedTransportChange(fn: (present: boolean) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
