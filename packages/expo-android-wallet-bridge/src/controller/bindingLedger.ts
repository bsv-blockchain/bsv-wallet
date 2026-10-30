/**
 * Per-binding bookkeeping (spec 6.7): last activity, parked and in-flight counts, the binding secret (a private copy,
 * wiped on close), the settled flag and the client-gone set. Memory only. The router compares secrets in constant
 * time; the session reads `idleSince` for the reaper and `isSettled` for the 60 s unsettled expiry.
 */
import type { BindingLedgerPort } from '@bsv/expo-wallet-toolbox/core/bridge/loopback/routerTypes'

interface Entry {
  origin: string
  secret: Uint8Array
  last: number
  parked: number
  inFlight: number
  settled: boolean
}

export function createBindingLedger(clock: () => number): BindingLedgerPort {
  const entries = new Map<string, Entry>()
  const gone = new Set<string>()
  const bump = (e: Entry, key: 'parked' | 'inFlight', delta: 1 | -1) => {
    e[key] = Math.max(0, e[key] + delta)
    e.last = clock()
  }
  return {
    open(epoch, origin, secret) {
      entries.get(epoch)?.secret.fill(0)
      entries.set(epoch, {
        origin,
        secret: Uint8Array.from(secret),
        last: clock(),
        parked: 0,
        inFlight: 0,
        settled: false
      })
    },
    secret: epoch => entries.get(epoch)?.secret,
    origin: epoch => entries.get(epoch)?.origin,
    touch(epoch) {
      const e = entries.get(epoch)
      if (e) e.last = clock()
    },
    inFlight(epoch, delta) {
      const e = entries.get(epoch)
      if (e) bump(e, 'inFlight', delta)
    },
    parked(epoch, delta) {
      const e = entries.get(epoch)
      if (e) bump(e, 'parked', delta)
    },
    markSettled(epoch) {
      const e = entries.get(epoch)
      if (e) e.settled = true
    },
    isSettled: epoch => entries.get(epoch)?.settled === true,
    markGone: connId => void gone.add(connId),
    isGone: connId => gone.has(connId),
    clearGone: connId => void gone.delete(connId),
    idleSince(epoch) {
      const e = entries.get(epoch)
      if (!e || e.parked > 0 || e.inFlight > 0) return undefined
      return e.last
    },
    epochsForOrigin: origin =>
      Array.from(entries)
        .filter(([, e]) => e.origin === origin)
        .map(([epoch]) => epoch),
    close(epoch) {
      entries.get(epoch)?.secret.fill(0)
      entries.delete(epoch)
    }
  }
}
