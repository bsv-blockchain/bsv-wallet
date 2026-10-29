/**
 * In-memory port of the Kotlin module with its semantics (spec 6.2, 10). Not for production.
 *
 * - Time is virtual: `elapsedRealtime()` is `base + elapsed`, and `advance(ms)` is the only thing that moves it, firing
 *   named timers (`onTimer`) in deadline order, ties in the order they were set. `opts.now` is read once for the base.
 * - `takeLaunches()` mirrors `LaunchStore`: destructive, entries older than 120 s dropped, 32 entries (oldest evicted).
 * - `respond` resolves false once the peer is gone (`emitGone`), and the response is captured in `responses` otherwise.
 */
import type {
  AttentionKind,
  BsvAndroidBridgeEvents,
  BsvAndroidBridgeNative,
  NativeHeaders,
  NativeLaunch,
  NativeRequest,
  NotificationPermission
} from '../native'

export interface FakeResponse {
  id: string
  status: number
  headers: NativeHeaders
  body: string
}

export interface FakeNative extends BsvAndroidBridgeNative {
  /** Deliver `onRequest`; unspecified fields default to a `GET /` with no headers. */
  emitRequest(req: Partial<NativeRequest> & { id: string }): void
  emitGone(id: string): void
  /** Put a launch URI into the store (age 0) and deliver the `onLaunch` nudge. */
  emitLaunch(uri: string): number
  /** Put a launch URI into the store as if it had been created `ageMs` ago, with no nudge. */
  pushLaunch(uri: string, ageMs: number): number
  /** Deliver `onServerStopped` and drop the listener state, as Kotlin does. */
  emitServerStopped(reason: BsvAndroidBridgeEvents['onServerStopped']['reason']): void
  /** Move virtual time forward, firing due timers in order. */
  advance(ms: number): void
  responses: FakeResponse[]
  aborted: string[]
  /** `ensureService()` resolves this; false models Android refusing the foreground service. */
  ensureServiceResult: boolean
  /** What `startServer` resolves, or an Error to reject with. */
  startServerResult: { port: number; ipv4: boolean; ipv6: boolean } | Error | undefined
  notificationPermissionState: NotificationPermission
  serverRunning: boolean
  activeTimers(): { name: string; due: number }[]
  /** Ordered log of calls with their arguments, for assertions. */
  calls: { name: string; args: unknown[] }[]
}

export interface FakeNativeOptions {
  now?: () => number
}

const LAUNCH_TTL_MS = 120_000
const LAUNCH_CAPACITY = 32

export function createFakeNative(opts: FakeNativeOptions = {}): FakeNative {
  const base = opts.now ? opts.now() : 0
  let elapsed = 0
  const time = () => base + elapsed

  const listeners = new Map<string, Set<(p: any) => void>>()
  const timers = new Map<string, { due: number; order: number }>()
  let timerOrder = 0
  const gone = new Set<string>()
  const launches: { seq: number; uri: string; createdAt: number }[] = []
  let nextSeq = 1

  const emit = <E extends keyof BsvAndroidBridgeEvents>(name: E, payload: BsvAndroidBridgeEvents[E]) => {
    for (const cb of Array.from(listeners.get(name) ?? [])) cb(payload)
  }

  const putLaunch = (uri: string, createdAt: number): number => {
    dropExpired()
    while (launches.length >= LAUNCH_CAPACITY) launches.shift()
    const seq = nextSeq++
    launches.push({ seq, uri, createdAt })
    return seq
  }
  const dropExpired = () => {
    const now = time()
    for (let i = launches.length - 1; i >= 0; i--)
      if (now - launches[i].createdAt > LAUNCH_TTL_MS) launches.splice(i, 1)
  }

  const fake: FakeNative = {
    responses: [],
    aborted: [],
    ensureServiceResult: true,
    startServerResult: undefined,
    notificationPermissionState: 'granted',
    serverRunning: false,
    calls: [],

    async startServer(o) {
      fake.calls.push({ name: 'startServer', args: [o] })
      const r = fake.startServerResult
      if (r instanceof Error) throw r
      fake.serverRunning = true
      return r ?? { port: o.basePort, ipv4: true, ipv6: true }
    },
    async stopServer() {
      fake.calls.push({ name: 'stopServer', args: [] })
      fake.serverRunning = false
    },
    async respond(id, status, headers, body) {
      fake.calls.push({ name: 'respond', args: [id, status] })
      if (gone.has(id)) return false
      fake.responses.push({ id, status, headers, body })
      return true
    },
    abortConnection(id) {
      fake.calls.push({ name: 'abortConnection', args: [id] })
      fake.aborted.push(id)
      gone.add(id)
    },
    takeLaunches(): NativeLaunch[] {
      dropExpired()
      const now = time()
      const out = launches.map(l => ({ seq: l.seq, uri: l.uri, ageMs: now - l.createdAt }))
      launches.length = 0
      return out
    },
    elapsedRealtime: () => time(),
    setTimer(name, ms) {
      fake.calls.push({ name: 'setTimer', args: [name, ms] })
      timers.set(name, { due: time() + ms, order: timerOrder++ })
    },
    clearTimer(name) {
      fake.calls.push({ name: 'clearTimer', args: [name] })
      timers.delete(name)
    },
    async ensureService() {
      fake.calls.push({ name: 'ensureService', args: [] })
      return fake.ensureServiceResult
    },
    setSession(sites, waiting) {
      fake.calls.push({ name: 'setSession', args: [sites, waiting] })
    },
    stopSession() {
      fake.calls.push({ name: 'stopSession', args: [] })
    },
    postAttention(kind: AttentionKind) {
      fake.calls.push({ name: 'postAttention', args: [kind] })
    },
    cancelAttention() {
      fake.calls.push({ name: 'cancelAttention', args: [] })
    },
    notificationPermission: () => fake.notificationPermissionState,
    async requestNotificationPermission() {
      fake.calls.push({ name: 'requestNotificationPermission', args: [] })
      return fake.notificationPermissionState === 'granted' ? 'granted' : 'denied'
    },
    returnToBrowser() {
      fake.calls.push({ name: 'returnToBrowser', args: [] })
    },
    addListener(name, cb) {
      let set = listeners.get(name)
      if (!set) listeners.set(name, (set = new Set()))
      set.add(cb)
      return { remove: () => void set!.delete(cb) }
    },

    emitRequest(req) {
      emit('onRequest', { method: 'GET', target: '/', headers: [], body: '', ...req })
    },
    emitGone(id) {
      gone.add(id)
      emit('onClientGone', { id })
    },
    emitLaunch(uri) {
      const seq = putLaunch(uri, time())
      emit('onLaunch', { seq })
      return seq
    },
    pushLaunch(uri, ageMs) {
      return putLaunch(uri, time() - ageMs)
    },
    emitServerStopped(reason) {
      fake.serverRunning = false
      emit('onServerStopped', { reason })
    },
    advance(ms) {
      const target = time() + ms
      for (;;) {
        let next: [string, { due: number; order: number }] | undefined
        for (const e of timers) {
          if (e[1].due > target) continue
          if (!next || e[1].due < next[1].due || (e[1].due === next[1].due && e[1].order < next[1].order)) next = e
        }
        if (!next) break
        timers.delete(next[0])
        elapsed = Math.max(elapsed, next[1].due - base)
        emit('onTimer', { name: next[0] })
      }
      elapsed = target - base
    },
    activeTimers: () => Array.from(timers, ([name, t]) => ({ name, due: t.due })).sort((a, b) => a.due - b.due)
  }
  return fake
}
