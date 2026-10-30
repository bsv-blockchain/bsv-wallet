/**
 * Unsettled-binding gate (spec 7.6). A binding is unsettled from creation until its origin is connected for it or it
 * closes. At most one unsettled binding per origin exists, so at most one binding of an origin can be parked behind a
 * consent request and the token goes to that owner only. The router checks `check` before it burns the launch proof and
 * again in the synchronous turn of `connectExplicit`.
 */
import type { UnsettledGatePort } from '@bsv/expo-wallet-toolbox/core/bridge/loopback/routerTypes'

export interface UnsettledGateDeps {
  /** Closes a binding `disconnected` (core registry close): the core then removes its consent request. */
  closeDisconnected?(epoch: string): void
}

export type UnsettledGate = UnsettledGatePort & {
  isOwner(origin: string, epoch: string): boolean
  /**
   * The page went away while the owner's only request was parked behind consent: close the binding
   * `disconnected` and free the origin. False when `epoch` is not an unsettled owner.
   */
  abandon(epoch: string): boolean
}

export function createUnsettledGate(deps: UnsettledGateDeps = {}): UnsettledGate {
  const owners = new Map<string, string>()
  const gate: UnsettledGate = {
    check: origin => !owners.has(origin),
    claim(origin, epoch) {
      owners.set(origin, epoch)
    },
    release(epoch) {
      for (const [origin, owner] of Array.from(owners)) if (owner === epoch) owners.delete(origin)
    },
    isOwner: (origin, epoch) => owners.get(origin) === epoch,
    abandon(epoch) {
      let found = false
      for (const owner of owners.values()) if (owner === epoch) found = true
      if (!found) return false
      gate.release(epoch)
      deps.closeDisconnected?.(epoch)
      return true
    }
  }
  return gate
}
