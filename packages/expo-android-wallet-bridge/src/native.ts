/**
 * TypeScript surface of the Kotlin module `BsvAndroidBridge` (spec 6.2, milestone 1 only). Kotlin is a dumb pipe:
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

export interface BsvAndroidBridgeEvents {
  onRequest: NativeRequest
  onClientGone: { id: string }
  onServerStopped: { reason: ServerStopReason }
  /** A nudge only: JS pulls with `takeLaunches()`. */
  onLaunch: { seq: number }
  /** Fires from a Kotlin `Handler` timer while no ReactActivity is resumed. */
  onTimer: { name: string }
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
