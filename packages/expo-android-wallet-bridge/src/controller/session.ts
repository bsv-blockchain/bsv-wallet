/**
 * Session machine (spec 7.1, 7.2, 6.7 step 4): IDLE (no listener, no service), ARMED (a launch is live, server
 * listening, no binding) and ACTIVE (at least one binding). Implements the toolbox `SessionPort` for the router and
 * owns every deadline timer, all of them Kotlin `Handler` timers (`native.setTimer`): React Native's JS timers pause
 * while Chrome is in front. Timer names: `armed`, `chain`, `reaper`, `unsettled:<epoch>`, `parked:<id>`.
 *
 * Invariant (7.1): a session is valid only while the host's React tree is mounted. Detach stops the server and answers
 * every parked connect `unavailable`; a still-live launch record re-arms the server only on the next attach.
 */
import type {
  ParkResult,
  SessionPort,
  BindingLedgerPort
} from '@bsv/expo-wallet-toolbox/core/bridge/loopback/routerTypes'
import type { BridgeSnapshot } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import type { BsvAndroidBridgeNative } from '../native'
import type { LaunchRegistry } from './launchRegistry'

export const BASE_PORT = 3321
export const MAX_PORT_OFFSET = 63
export const ARMED_MS = 120_000
export const CHAIN_CAP_MS = 600_000
export const PARKED_DEADLINE_MS = 600_000
export const MAX_PARKED_CONNECTS = 4
export const UNSETTLED_MS = 60_000
export const REAPER_INTERVAL_MS = 60_000
export const IDLE_BINDING_MS = 30 * 60_000
const RECHECK_MS = 5_000

export type SessionState = 'IDLE' | 'ARMED' | 'ACTIVE'

export interface Session extends SessionPort {
  state(): SessionState
  /** A launch was ingested: arm the server if it is idle, or renew the armed deadline. */
  onLaunch(): void
  onHostAttached(attached: boolean): void
  /** The bridge snapshot changed: release parked connects once the wallet is ready (or known absent). */
  onSnapshot(): void
  /** The page behind a connect request went away. */
  onClientGone(connId: string): void
  /** The binding's origin is connected for it (consent approved or token matched): stop the 60 s expiry. */
  onSettled(epoch: string): void
  /** The server stopped under us (`stopped`, `user-disconnect`, `error`): every binding closes lost. */
  onServerStopped(): void
  onTimer(name: string): void
  /** Pending-request count for the notification text (a number only, never a site). */
  setWaiting(n: number): void
  parkedCount(): number
}

interface Parked {
  id: string
  epoch: string
  resolve(r: ParkResult): void
}

export function createSession(deps: {
  native: Pick<
    BsvAndroidBridgeNative,
    | 'ensureService'
    | 'startServer'
    | 'stopServer'
    | 'setTimer'
    | 'clearTimer'
    | 'elapsedRealtime'
    | 'setSession'
    | 'stopSession'
  >
  registry: LaunchRegistry
  ledger: BindingLedgerPort
  closeLost(epoch: string): void
  getSnapshot(): BridgeSnapshot
  clock: () => number
}): Session {
  const { native, registry, ledger, closeLost, getSnapshot, clock } = deps

  let state: SessionState = 'IDLE'
  const bindings = new Set<string>()
  const parked = new Map<string, Parked>()
  let attached = getSnapshot().hostAttached
  /** True from a true-to-false host transition until the next attach: nothing may arm in between. */
  let suspended = false
  let arming = false
  /** Bumped by every stop, so an arm that was awaiting `ensureService` or `startServer` can tell it was overtaken. */
  let generation = 0
  let chainStart = 0
  let armedElapsed = false
  let chainElapsed = false
  let waiting = 0

  const publish = () => native.setSession(bindings.size, waiting)

  const clearArmTimers = () => {
    native.clearTimer('armed')
    native.clearTimer('chain')
    armedElapsed = false
    chainElapsed = false
  }

  const setArmedTimer = () => {
    const expiry = registry.lastExpiresAt()
    const remaining = expiry === undefined ? ARMED_MS : Math.max(0, expiry - native.elapsedRealtime())
    armedElapsed = false
    native.setTimer('armed', remaining)
  }

  const stop = () => {
    generation++
    clearArmTimers()
    native.clearTimer('reaper')
    for (const epoch of bindings) native.clearTimer(`unsettled:${epoch}`)
    state = 'IDLE'
    native.stopServer().catch(() => {})
    native.stopSession()
  }

  const closeAllLost = () => {
    for (const epoch of Array.from(bindings)) closeLost(epoch)
    bindings.clear()
  }

  const settleParked = (p: Parked, result: ParkResult) => {
    if (parked.get(p.id) !== p) return
    parked.delete(p.id)
    native.clearTimer(`parked:${p.id}`)
    registry.markParked(p.epoch, false)
    p.resolve(result)
  }
  const settleAllParked = (result: ParkResult) => {
    for (const p of Array.from(parked.values())) settleParked(p, result)
  }

  /** ARMED ends once its deadlines passed and nothing is parked; a parked connect keeps ARMED until it resolves. */
  const maybeExpire = () => {
    if (state === 'ARMED' && (armedElapsed || chainElapsed) && parked.size === 0) stop()
  }

  const arm = async () => {
    if (arming || state !== 'IDLE' || suspended || !registry.hasLive()) return
    arming = true
    const mine = generation
    chainStart = clock()
    try {
      // Nothing opens unless Android accepts the foreground service; the record stays unburnt for a retry.
      if (!(await native.ensureService())) return
      if (mine !== generation || suspended) {
        native.stopSession()
        return
      }
      try {
        await native.startServer({ basePort: BASE_PORT, maxOffset: MAX_PORT_OFFSET })
      } catch {
        if (mine === generation) native.stopSession()
        return
      }
      if (mine !== generation || suspended) {
        native.stopServer().catch(() => {})
        native.stopSession()
        return
      }
      state = 'ARMED'
      publish()
      setArmedTimer()
      chainElapsed = false
      native.setTimer('chain', Math.max(0, CHAIN_CAP_MS - (clock() - chainStart)))
    } finally {
      arming = false
    }
  }

  const reevaluate = () => {
    const s = getSnapshot()
    if (!s.hostAttached || parked.size === 0) return
    if (s.readiness === 'ready') {
      settleAllParked('resume')
      // If a released connect then fails without opening a binding, ARMED must still be able to expire.
      if (state === 'ARMED' && (armedElapsed || chainElapsed)) native.setTimer('armed', RECHECK_MS)
    } else if (s.readiness === 'none') {
      settleAllParked('unavailable')
      maybeExpire()
    }
  }

  const session: Session = {
    state: () => state,
    parkedCount: () => parked.size,

    readiness() {
      const s = getSnapshot()
      if (!s.hostAttached) return 'park'
      if (s.readiness === 'ready') return 'go'
      if (s.readiness === 'none') return 'none-fail'
      return 'park'
    },

    parkConnect(id, _origin, epoch) {
      if (parked.size >= MAX_PARKED_CONNECTS) return Promise.resolve('full')
      return new Promise<ParkResult>(resolve => {
        const p: Parked = { id, epoch, resolve }
        parked.set(id, p)
        registry.markParked(epoch, true)
        native.setTimer(`parked:${id}`, PARKED_DEADLINE_MS)
      })
    },

    onConnect(epoch) {
      bindings.add(epoch)
      state = 'ACTIVE'
      clearArmTimers()
      native.setTimer('reaper', REAPER_INTERVAL_MS)
      native.setTimer(`unsettled:${epoch}`, UNSETTLED_MS)
      publish()
    },

    onBindingClosed(epoch) {
      native.clearTimer(`unsettled:${epoch}`)
      if (!bindings.delete(epoch)) return
      publish()
      if (state !== 'ACTIVE' || bindings.size > 0) return
      native.clearTimer('reaper')
      if (registry.hasLive() || parked.size > 0) {
        state = 'ARMED'
        chainStart = clock()
        setArmedTimer()
        chainElapsed = false
        native.setTimer('chain', CHAIN_CAP_MS)
      } else {
        stop()
      }
    },

    onLaunch() {
      if (suspended) return
      if (state === 'IDLE') void arm()
      else if (state === 'ARMED') setArmedTimer()
    },

    onHostAttached(next) {
      if (next === attached) return
      attached = next
      if (next) {
        suspended = false
        reevaluate()
        if (state === 'IDLE') void arm()
        return
      }
      // Detach: the core closes its registry bindings itself; here the server, the parked connects and the ledger go.
      suspended = true
      settleAllParked('unavailable')
      closeAllLost()
      stop()
    },

    onSnapshot() {
      reevaluate()
    },

    onClientGone(connId) {
      const p = parked.get(connId)
      // The slot is freed; the launch record stays burnt (the epoch is tombstoned).
      if (p) {
        settleParked(p, 'dropped')
        maybeExpire()
      }
    },

    onSettled(epoch) {
      native.clearTimer(`unsettled:${epoch}`)
    },

    onServerStopped() {
      settleAllParked('unavailable')
      closeAllLost()
      stop()
    },

    setWaiting(n) {
      waiting = n
      if (state !== 'IDLE') publish()
    },

    onTimer(name) {
      if (name === 'armed') {
        armedElapsed = true
        maybeExpire()
      } else if (name === 'chain') {
        chainElapsed = true
        maybeExpire()
      } else if (name === 'reaper') {
        if (state !== 'ACTIVE') return
        const now = clock()
        for (const epoch of Array.from(bindings)) {
          const idle = ledger.idleSince(epoch)
          if (idle !== undefined && now - idle >= IDLE_BINDING_MS) closeLost(epoch)
        }
        if (state === 'ACTIVE') native.setTimer('reaper', REAPER_INTERVAL_MS)
      } else if (name.startsWith('unsettled:')) {
        const epoch = name.slice('unsettled:'.length)
        if (!bindings.has(epoch) || ledger.isSettled(epoch)) return
        // Nothing parked or in flight: close. Otherwise look again later.
        if (ledger.idleSince(epoch) !== undefined) closeLost(epoch)
        else native.setTimer(name, UNSETTLED_MS)
      } else if (name.startsWith('parked:')) {
        const p = parked.get(name.slice('parked:'.length))
        if (p) {
          settleParked(p, 'unavailable')
          maybeExpire()
        }
      }
    }
  }
  return session
}
