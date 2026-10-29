/**
 * TypeScript surface of the Kotlin module `BsvAndroidBridge` (spec 6.2). Kotlin is a dumb pipe:
 * every BRC-185 behaviour lives in the TS controller. Request bodies, launch URIs and header values are secrets or
 * page-controlled input and are never logged by anything that handles these types.
 */

/** Ordered `[lowercasedName, value]` pairs; `Accept`, `Accept-Encoding` and `User-Agent` are dropped by Kotlin. */
export type NativeHeaders = [string, string][]

export interface NativeRequest {
  id: string
  method: string
  /** Origin-form request target, exactly as received (never decoded or normalised). */
  target: string
  headers: NativeHeaders
  body: string
}

/** Why the server stopped: JS asked, the notification Disconnect action, or a listener error. */
export type ServerStopReason = 'stopped' | 'user-disconnect' | 'error'

export interface NativeLaunch {
  seq: number
  uri: string
  /** Age in Kotlin's clock when taken; the 120 s record life is counted from creation. */
  ageMs: number
}

export type AttentionKind = 'consent' | 'prompt' | 'wallet-not-ready'
export type NotificationPermission = 'granted' | 'denied' | 'undetermined'

/**
 * What the native lifecycle tracker knows about the two Activities (spec 7.4). `registered` is false until the module has
 * caught up with the Activity that existed before it loaded (about 1.8 s after a cold start); while it is false the other
 * three fields are not to be trusted and callers fall back to `AppState`.
 */
export interface HostLifecycle {
  registered: boolean
  mainAlive: boolean
  mainResumed: boolean
  sheetResumed: boolean
}

export interface BsvAndroidBridgeEvents {
  onRequest: NativeRequest
  onClientGone: { id: string }
  onServerStopped: { reason: ServerStopReason }
  /** A nudge only: JS pulls with `takeLaunches()`. */
  onLaunch: { seq: number }
  /** Fires from a Kotlin `Handler` timer while no ReactActivity is resumed. */
  onTimer: { name: string }
  /** Fires on every change of the four `HostLifecycle` values, including the catch-up. */
  onHostLifecycle: HostLifecycle
}

export interface NativeSubscription {
  remove(): void
}

export interface BsvAndroidBridgeNative {
  startServer(o: { basePort: number; maxOffset: number }): Promise<{ port: number; ipv4: boolean; ipv6: boolean }>
  stopServer(): Promise<void>
  /** Resolves false when the peer is already gone. */
  respond(id: string, status: number, headers: NativeHeaders, body: string): Promise<boolean>
  abortConnection(id: string): void
  /** Synchronous and destructive: returns and deletes every unexpired entry (spec 7.5). */
  takeLaunches(): NativeLaunch[]
  /** Synchronous monotonic milliseconds. */
  elapsedRealtime(): number
  setTimer(name: string, ms: number): void
  clearTimer(name: string): void
  /** False when Android refused the foreground service; the caller then opens no port. */
  ensureService(): Promise<boolean>
  /** Notification counts only: no site names, no secrets. */
  setSession(sites: number, waiting: number): void
  stopSession(): void
  postAttention(kind: AttentionKind): void
  cancelAttention(): void
  notificationPermission(): NotificationPermission
  requestNotificationPermission(): Promise<'granted' | 'denied'>
  /** Mirrors the toolbox bridge host state so the native trampoline can choose overlay or foreground mode. */
  setHostState(s: { attached: boolean; ready: boolean }): void
  /** Synchronous snapshot of the native lifecycle tracker. */
  hostLifecycle(): HostLifecycle
  /** Whether the sheet window takes touches (declared in M2 Task 5, implemented in Task 7). */
  setSheetInteractive(on: boolean): void
  /** Raises the sheet without a browser launch. Declared as a no-op: only the owner-decision variant (11-W) gives it a body. */
  showSheet(reason: 'consent' | 'prompt'): void
  /** Finishes the live sheet, if any. */
  hideSheet(): void
  /** M1: moveTaskToBack of the wallet task, only when the bridge raised it. */
  returnToBrowser(): void
  addListener<E extends keyof BsvAndroidBridgeEvents>(
    name: E,
    cb: (payload: BsvAndroidBridgeEvents[E]) => void
  ): NativeSubscription
}

let cached: BsvAndroidBridgeNative | undefined

/** The real native module, loaded lazily so importing the kit in jest or on iOS does not throw until it is used. */
export function getBsvAndroidBridge(): BsvAndroidBridgeNative {
  if (!cached) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requireNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core')
    cached = requireNativeModule('BsvAndroidBridge') as BsvAndroidBridgeNative
  }
  return cached
}
