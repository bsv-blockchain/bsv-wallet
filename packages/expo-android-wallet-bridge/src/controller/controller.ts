/**
 * The protocol controller (spec 6.12, 6.7, 6.9, 7.2): wires Kotlin's events to the toolbox router and to the session
 * machine, and owns the settle and teardown rules the router does not.
 *
 * - `onRequest` -> `router.handle` -> write. A `hold` plan awaits `settled`, then writes; a peer that left makes the
 *   write resolve false and nothing else happens (the reconnect token, if any, stays in the outbox).
 * - `onClientGone` -> the ledger's gone set (read by the router at the connect gate and before the wallet is called),
 *   the session's parked slot, and, for an unsettled owner whose only held request was parked behind consent, the
 *   binding closes `disconnected` (spec 7.6 withdrawal).
 * - `onServerStopped` (every reason, including the notification Disconnect action) -> every binding closes `lost`.
 * - Core-initiated closes (revoked, account-changed, disconnected) arrive through the transport's `onClosed` and run
 *   the same idempotent teardown as the router's own DELETE and rollback paths.
 *
 * Nothing here logs. `k`, epochs, tokens, binding secrets, headers and bodies are never written anywhere.
 */
import type { Binding, BindingRegistry, CloseEvent } from '@bsv/expo-wallet-toolbox/core/bridge/bindings'
import type {
  BindingLedgerPort,
  LoopbackRouter,
  RoutePlan,
  RouteResponse,
  TokenOutboxPort
} from '@bsv/expo-wallet-toolbox/core/bridge/loopback/routerTypes'
import type { ContinuityStore } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/continuity'
import {
  onConnectedSitesChange,
  onSnapshotChange,
  type BridgeSnapshot
} from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import type { BsvAndroidBridgeNative, NativeRequest, NativeSubscription } from '../native'
import type { Attention } from './attention'
import type { LaunchRegistry } from './launchRegistry'
import type { Notices } from './notices'
import type { Session } from './session'
import type { UnsettledGate } from './unsettledGate'

const RPC_PREFIX = '/brc185/v1/rpc/'
const CONTINUITY_PREFIX = 'android:'

export interface ControllerDeps {
  native: BsvAndroidBridgeNative
  router: LoopbackRouter
  session: Session
  launchRegistry: LaunchRegistry
  ledger: BindingLedgerPort
  gate: UnsettledGate
  outbox: TokenOutboxPort & { put(epoch: string, token: string): void }
  registry: BindingRegistry
  continuity: ContinuityStore
  getSnapshot(): BridgeSnapshot
  clock: () => number
  transportId: string
  attention?: Attention
  notices?: Notices
}

export interface Controller {
  /** Handle one request from Kotlin; resolves once the response was written (or the peer was gone). */
  onRequest(req: NativeRequest): Promise<void>
  closeLost(epoch: string): void
  closeDisconnected(epoch: string): void
  /** Close every binding of one origin `lost` (the continuity identity for it was reset). */
  closeContext(origin: string): void
  closeAll(): void
  /** The `onReset` hook for `createSecureStoreContinuity`: `'all'` or `'android:' + origin`. */
  onContinuityReset(ctx: string): void
  /** The transport callbacks the core calls. */
  transport: {
    onClosed(e: CloseEvent): void
    deliverReconnectToken(binding: Binding, token: string): void
  }
  /** Logout: rotate every identity, close every binding lost, stop the server and the session. */
  reset(): Promise<void>
  /** Pull launches left by a cold start (or a reload) and arm the session if one is live. */
  start(): void
  dispose(): void
}

function internalResponse(): RouteResponse {
  return {
    status: 500,
    headers: [
      ['Content-Type', 'application/json'],
      ['Cache-Control', 'no-store'],
      ['Vary', 'Origin'],
      ['X-Content-Type-Options', 'nosniff']
    ],
    body: JSON.stringify({ code: 'CONFIGURATION_ERROR', message: 'Internal error', delivery: 'not-sent' })
  }
}

function header(headers: [string, string][], name: string): string | undefined {
  for (const [k, v] of headers) if (k === name) return v
  return undefined
}

export function createController(deps: ControllerDeps): Controller {
  const { native, router, session, launchRegistry, ledger, gate, outbox, registry, continuity, transportId } = deps
  const { attention, notices } = deps

  /** Every request between arrival and the end of its write, so a late `onClientGone` marks only a live request. */
  const active = new Set<string>()
  /** Held RPC requests by epoch, for the abandoned-consent rule. */
  const heldByEpoch = new Map<string, Set<string>>()
  const epochOfHeld = new Map<string, string>()
  const subs: NativeSubscription[] = []
  const unsubs: Array<() => void> = []
  let disposed = false

  /** Teardown for one binding. Every call is idempotent: the router's DELETE path and the registry's close listener run it too. */
  const cleanup = (epoch: string) => {
    ledger.close(epoch)
    gate.release(epoch)
    outbox.drop(epoch)
    session.onBindingClosed(epoch)
    attention?.clear(epoch)
  }

  const closeBinding = (epoch: string, reason: 'lost' | 'disconnected') => {
    try {
      registry.close(epoch, reason)
    } catch {
      /* already closed: the cleanup below is still owed */
    }
    cleanup(epoch)
  }

  /** The origin is connected for this binding: stop the unsettled expiry and free the origin's single slot. */
  const settle = (epoch: string) => {
    if (ledger.origin(epoch) === undefined || ledger.isSettled(epoch)) return
    ledger.markSettled(epoch)
    gate.release(epoch)
    session.onSettled(epoch)
  }

  /** The reconnect-token path flips `consented` without calling the transport, so look after responses and site changes. */
  const checkSettled = () => {
    for (const b of registry.live()) if (b.transportId === transportId && b.consented) settle(b.epoch)
  }

  const closeLost = (epoch: string) => closeBinding(epoch, 'lost')
  const closeDisconnected = (epoch: string) => closeBinding(epoch, 'disconnected')

  const closeAll = () => {
    const epochs = new Set<string>()
    for (const b of registry.live()) if (b.transportId === transportId) epochs.add(b.epoch)
    for (const epoch of epochs) closeLost(epoch)
  }

  const closeContext = (origin: string) => {
    for (const epoch of ledger.epochsForOrigin(origin)) closeLost(epoch)
  }

  const rpcEpoch = (req: NativeRequest): string | undefined =>
    req.method === 'POST' && req.target.startsWith(RPC_PREFIX) ? header(req.headers, 'brc-185-epoch') : undefined

  const write = async (req: NativeRequest, res: RouteResponse) => {
    let written = false
    try {
      written = await native.respond(req.id, res.status, res.headers, res.body)
    } catch {
      written = false
    }
    // The token leaves the outbox only once the head reached the socket; a failed write keeps it for the next response.
    if (written && res.headers.some(([k]) => k.toLowerCase() === 'brc-185-reconnect-token')) {
      const epoch = header(req.headers, 'brc-185-epoch')
      if (epoch !== undefined) outbox.confirmWritten(epoch)
    }
  }

  const onRequest = async (req: NativeRequest): Promise<void> => {
    active.add(req.id)
    const epoch = rpcEpoch(req)
    let held = false
    try {
      let plan: RoutePlan
      try {
        plan = await router.handle({
          id: req.id,
          method: req.method,
          target: req.target,
          headers: req.headers,
          body: req.body
        })
      } catch {
        plan = { kind: 'respond', ...internalResponse() }
      }
      let res: RouteResponse
      if (plan.kind === 'respond') {
        res = { status: plan.status, headers: plan.headers, body: plan.body }
      } else {
        held = true
        if (epoch !== undefined) {
          let set = heldByEpoch.get(epoch)
          if (!set) heldByEpoch.set(epoch, (set = new Set()))
          set.add(req.id)
          epochOfHeld.set(req.id, epoch)
        }
        try {
          res = await plan.settled
        } catch {
          res = internalResponse()
        }
      }
      await write(req, res)
    } finally {
      active.delete(req.id)
      ledger.clearGone(req.id)
      if (held && epoch !== undefined) {
        epochOfHeld.delete(req.id)
        const set = heldByEpoch.get(epoch)
        if (set) {
          set.delete(req.id)
          if (set.size === 0) heldByEpoch.delete(epoch)
        }
      }
      if (epoch !== undefined && ledger.idleSince(epoch) !== undefined) attention?.clear(epoch)
      checkSettled()
    }
  }

  const onClientGone = (id: string) => {
    if (!active.has(id)) return
    ledger.markGone(id)
    session.onClientGone(id)
    const epoch = epochOfHeld.get(id)
    if (epoch === undefined) return
    const origin = ledger.origin(epoch)
    // The unsettled owner's only held request was parked behind consent and the page is gone: withdraw the sheet.
    if (origin !== undefined && gate.isOwner(origin, epoch) && heldByEpoch.get(epoch)?.size === 1) {
      gate.abandon(epoch)
    }
  }

  const deliverReconnectToken = (binding: Binding, token: string) => {
    // Delivery is to the unsettled owner only (spec 7.6): any other binding of the origin gets nothing.
    if (!gate.isOwner(binding.applicationOrigin, binding.epoch)) return
    outbox.put(binding.epoch, token)
    settle(binding.epoch)
  }

  const onContinuityReset = (ctx: string) => {
    if (ctx === 'all') closeAll()
    else if (ctx.startsWith(CONTINUITY_PREFIX)) closeContext(ctx.slice(CONTINUITY_PREFIX.length))
  }

  const start = () => {
    launchRegistry.ingest()
    if (launchRegistry.hasLive()) {
      attention?.noteLaunch()
      notices?.noteLaunchAccepted()
      session.onLaunch()
    }
  }

  subs.push(
    native.addListener('onRequest', r => void onRequest(r)),
    native.addListener('onClientGone', p => onClientGone(p.id)),
    native.addListener('onLaunch', () => {
      launchRegistry.ingest()
      attention?.noteLaunch()
      if (launchRegistry.hasLive()) notices?.noteLaunchAccepted()
      session.onLaunch()
    }),
    native.addListener('onTimer', p => session.onTimer(p.name)),
    native.addListener('onServerStopped', () => session.onServerStopped())
  )
  // Host attach and readiness drive the parked connects (the host component does not need to).
  unsubs.push(
    onSnapshotChange(s => {
      session.onHostAttached(s.hostAttached)
      session.onSnapshot()
    }),
    onConnectedSitesChange(checkSettled)
  )

  return {
    onRequest,
    closeLost,
    closeDisconnected,
    closeContext,
    closeAll,
    onContinuityReset,
    transport: {
      onClosed: e => cleanup(e.epoch),
      deliverReconnectToken
    },
    async reset() {
      await continuity.reset('all')
      closeAll()
      session.onServerStopped()
    },
    start,
    dispose() {
      if (disposed) return
      disposed = true
      for (const s of subs) s.remove()
      for (const u of unsubs) u()
    }
  }
}
