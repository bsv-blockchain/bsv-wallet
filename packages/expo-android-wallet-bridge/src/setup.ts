/**
 * `setupAndroidBridge` (spec 6.12, 6.13): called once, at module scope, in the host's entry file, after the native
 * crypto bootstrap and before the router loads. It registers the `android-loopback` transport BEFORE the wallet is first
 * built (the unverified permissions manager exists only if an unattested transport was registered at build time, P1
 * 6.5), builds the controller, and drains `takeLaunches()` so a cold start from a launch is not lost. It opens no port.
 *
 * `createAndroidBridge` is the same wiring with every platform dependency injectable (native module, continuity store,
 * dispatcher, registry), which is how the tests drive it; it does not look at `Platform`.
 *
 * Host policy for `http://localhost:<port>` origins. The plan asked this entry to forward `allowLocalhostHttp` with
 * `configureToolbox({ browserBridge })`; that call replaces the host's whole toolbox configuration and throws without a
 * `backupUrl`, so the kit never calls it. The host states the flag in its own `configureToolbox` call. The router asks
 * `getBrowserBridgeConfig()` at request time with the same `__DEV__` gate the core registry uses, so the two agree, and
 * the `allowLocalhostHttp` option here can only switch the feature OFF (`false`).
 */
import { Platform } from 'react-native'
import { getBrowserBridgeConfig } from '@bsv/expo-wallet-toolbox/core/toolboxConfig'
import { dispatch as coreDispatch } from '@bsv/expo-wallet-toolbox/core/bridge/dispatcher'
import { createLoopbackRouter, type LoopbackBound } from '@bsv/expo-wallet-toolbox/core/bridge/loopback'
import type { BindingRegistry } from '@bsv/expo-wallet-toolbox/core/bridge/bindings'
import type { ContinuityStore } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/continuity'
import {
  getBindingRegistry,
  getBridgeSnapshot,
  registerTransport,
  type BridgeSnapshot,
  type TransportHandle
} from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { registerSessionTeardown } from '@bsv/expo-wallet-toolbox/core/context/sessionTeardown'
import { getBsvAndroidBridge, type BsvAndroidBridgeNative } from './native'
import { createSecureStoreContinuity, type ContinuityDeps } from './continuity/secureStoreContinuity'
import { createAttention, type Attention } from './controller/attention'
import { createBindingLedger } from './controller/bindingLedger'
import { createController, type Controller } from './controller/controller'
import { createNotices, type Notices } from './controller/notices'
import { createLaunchRegistry } from './controller/launchRegistry'
import { createSession, type Session } from './controller/session'
import { createTokenOutbox } from './controller/tokenOutbox'
import { createUnsettledGate } from './controller/unsettledGate'
import { ownerFromNative, setSheetOwnerSource, type SheetOwner } from './ui/sheetOwner'
import { registerSheetRoot } from './ui/registerSheetRoot'

export const ANDROID_TRANSPORT_ID = 'android-loopback'
export const LAUNCH_SCHEME = 'bsv-wallet-bridge'

const NOT_BOUND: LoopbackBound = { port: 0, ipv4: false, ipv6: false }

export interface SetupOptions {
  appName: string
  vendor: string
  /** Can only switch `http://localhost` origins OFF; the host enables them in `configureToolbox` (see the file header). */
  allowLocalhostHttp?: boolean
}

export interface AndroidBridgeDeps extends SetupOptions {
  native: BsvAndroidBridgeNative
  /** Replaces the SecureStore-backed store (tests). */
  continuity?: ContinuityStore
  /** Passed to `createSecureStoreContinuity` when `continuity` is not given (tests inject a fake store). */
  continuityDeps?: Omit<ContinuityDeps, 'onReset'>
  dispatch?: typeof coreDispatch
  registry?: BindingRegistry
  getSnapshot?: () => BridgeSnapshot
  /** Defaults to `native.elapsedRealtime`, the clock every deadline uses. */
  clock?: () => number
  /** Which window shows the sheet. Defaults to the native lifecycle tracker (`AppState` while it is unregistered). */
  owner?: () => SheetOwner
}

export interface AndroidBridge {
  controller: Controller
  session: Session
  attention: Attention
  /** Which window shows the sheet right now (the same reader the attention logic uses). */
  owner: () => SheetOwner
  /** Host-visible flags and the launch signal (for `AndroidBridgeHost` and `AndroidBridgeNotices`). */
  notices: Notices
  native: BsvAndroidBridgeNative
  continuity: ContinuityStore
  transport: TransportHandle
  /** Rotates every identity, closes every binding lost and stops the server and the session. */
  reset(): Promise<void>
  /** Removes the listeners and the transport. Tests; the app never tears the module-scope bridge down. */
  dispose(): void
}

const isDev = () => typeof __DEV__ !== 'undefined' && __DEV__ === true

export function createAndroidBridge(deps: AndroidBridgeDeps): AndroidBridge {
  const { native } = deps
  const getSnapshot = deps.getSnapshot ?? getBridgeSnapshot
  const registry = deps.registry ?? getBindingRegistry()
  const clock = deps.clock ?? (() => native.elapsedRealtime())
  const dispatch = deps.dispatch ?? coreDispatch

  // Late-bound: the session, the gate and the continuity hook all need the controller that needs them.
  let controller: Controller | undefined
  const late = () => controller as Controller

  let bound: LoopbackBound = NOT_BOUND
  // The session owns start and stop; this view records which ports bound so the router checks the exact Host set.
  const sessionNative = {
    ensureService: () => native.ensureService(),
    async startServer(o: { basePort: number; maxOffset: number }) {
      const r = await native.startServer(o)
      bound = { port: r.port, ipv4: r.ipv4, ipv6: r.ipv6 }
      return r
    },
    stopServer() {
      bound = NOT_BOUND
      return native.stopServer()
    },
    setTimer: (name: string, ms: number) => native.setTimer(name, ms),
    clearTimer: (name: string) => native.clearTimer(name),
    elapsedRealtime: () => native.elapsedRealtime(),
    setSession: (sites: number, waiting: number) => native.setSession(sites, waiting),
    stopSession: () => native.stopSession()
  }

  const continuity =
    deps.continuity ??
    createSecureStoreContinuity({ ...deps.continuityDeps, onReset: ctx => controller?.onContinuityReset(ctx) })
  const launchRegistry = createLaunchRegistry({ native, scheme: LAUNCH_SCHEME })
  const ledger = createBindingLedger(clock)
  const outbox = createTokenOutbox()
  const notices = createNotices()
  const gate = createUnsettledGate({ closeDisconnected: epoch => late().closeDisconnected(epoch) })
  const session = createSession({
    native: sessionNative,
    registry: launchRegistry,
    ledger,
    closeLost: epoch => late().closeLost(epoch),
    getSnapshot,
    clock,
    notices
  })
  const owner = deps.owner ?? (() => ownerFromNative(native))
  const attention = createAttention({ native, clock, owner })
  attention.onWaitingChange(n => session.setWaiting(n))

  const router = createLoopbackRouter({
    transportId: ANDROID_TRANSPORT_ID,
    bound: () => bound,
    identity: origin => continuity.getOrCreate(`android:${origin}`),
    descriptorBase: { name: deps.appName, vendor: deps.vendor, instanceLabel: deps.appName },
    launches: launchRegistry,
    unsettledGate: gate,
    tokenOutbox: outbox,
    session,
    ledger,
    registry,
    connectExplicit: input => registry.connectExplicit(input),
    snapshot: getSnapshot,
    dispatch,
    allowLocalhostHttp: () =>
      deps.allowLocalhostHttp !== false && isDev() && getBrowserBridgeConfig().allowLocalhostHttp === true
  })

  controller = createController({
    native,
    router,
    session,
    launchRegistry,
    ledger,
    gate,
    outbox,
    registry,
    continuity,
    getSnapshot,
    clock,
    transportId: ANDROID_TRANSPORT_ID,
    attention,
    notices
  })

  const transport = registerTransport({
    id: ANDROID_TRANSPORT_ID,
    attestation: 'unattested',
    bindingMode: 'explicit',
    requestAttention: attention.requestAttention,
    onPromptRaised: attention.onPromptRaised,
    onClosed: controller.transport.onClosed,
    deliverReconnectToken: controller.transport.deliverReconnectToken
  })
  controller.start()

  return {
    controller,
    session,
    attention,
    owner,
    notices,
    native,
    continuity,
    transport,
    reset: () => late().reset(),
    dispose() {
      late().dispose()
      transport.unregister()
    }
  }
}

let instance: AndroidBridge | undefined

/** The bridge the host entry created, for the host component. Undefined before `setupAndroidBridge` or off Android. */
export function getAndroidBridge(): AndroidBridge | undefined {
  return instance
}

export function setupAndroidBridge(o: SetupOptions): void {
  if (Platform.OS !== 'android') return
  // Module scope runs again on Fast Refresh: the first registration stays.
  if (instance) return
  const bridge = createAndroidBridge({ ...o, native: getBsvAndroidBridge() })
  instance = bridge
  // The second React root (the overlay sheet) is registered before this returns, so a cold start by the sheet Activity
  // finds `BsvBridgeSheet` in the registry; the owner reads the native lifecycle tracker.
  setSheetOwnerSource(bridge.native)
  registerSheetRoot()
  registerSessionTeardown(['logout'], () => void bridge.reset().catch(() => {}))
}

/** Logout and tests: rotate identities, close every binding lost, stop the server and the session. */
export async function resetAndroidBridge(): Promise<void> {
  await instance?.reset()
}

/** Test seam: forget the module-scope instance (after the test disposed it). */
export function __resetAndroidBridgeForTests(): void {
  instance = undefined
}
