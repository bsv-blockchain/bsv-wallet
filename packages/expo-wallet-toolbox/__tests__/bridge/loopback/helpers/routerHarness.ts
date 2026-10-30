/**
 * Shared harness for the loopback router tests (Tasks 6 to 8): a fake `RouterEnv` whose ports record every call, a
 * real Ed25519 `ContinuityHandle` (so describe responses verify with `verifyDescribeProof`), and request builders.
 *
 * Tasks 7 and 8 extend this file with the connect and RPC fakes (a real `createDispatcher` over a fake manager, as
 * in `dispatcher.test.ts`); Task 6 only needs ports that record calls.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { b64uEncode } from '../../../../core/bridge/protocol/base64url'
import type { ContinuityHandle } from '../../../../core/bridge/protocol/continuity'
import { createBindingRegistry, type ExplicitConnectInput } from '../../../../core/bridge/bindings'
import type { dispatch as dispatchFn } from '../../../../core/bridge/dispatcher'
import { helloMac } from '../../../../core/bridge/loopback/launchProof'
import {
  createLoopbackRouter,
  type LaunchRecordView,
  type ParkResult,
  type RawRequest,
  type RouteHandler,
  type RouteKind,
  type RoutePlan,
  type RouteResponse,
  type RouterEnv
} from '../../../../core/bridge/loopback'

export const PORT = 3321
export const ORIGIN = 'https://example.com'
export const CHALLENGE = b64uEncode(new Uint8Array(32).fill(7))
export const HELLO_KEY = new Uint8Array(32).fill(9)
export const NONCE = b64uEncode(new Uint8Array(16).fill(5))
export const EPOCH = '7a5d2b1e-3c4f-4a6b-8d9e-0f1a2b3c4d5e'
export const HOST4 = `127.0.0.1:${PORT}`
export const HOST6 = `[::1]:${PORT}`
export const HOSTL = `localhost:${PORT}`

const SEED = new Uint8Array(32).fill(3)
const PUB = ed25519.getPublicKey(SEED)

export const identityHandle: ContinuityHandle = {
  instanceId: '11111111-2222-4333-8444-555555555555',
  continuityKey: b64uEncode(PUB),
  sign: async preimage => ed25519.sign(preimage, SEED)
}

export interface Harness {
  env: RouterEnv
  /** Every port call, as `port.method`. */
  calls: string[]
  /** Mutable test knobs. */
  state: {
    bound: { port: number; ipv4: boolean; ipv6: boolean }
    allowLocalhostHttp: boolean
    records: LaunchRecordView[]
    snapshotCalls: number
    /** Connect knobs (Task 7). `snapshot` unset keeps the Task 6 rule that describe never reads it. */
    snapshot?: { accountContext: string; walletRevision: string }
    used: Set<string>
    gateBusy: Set<string>
    readiness: 'park' | 'none-fail' | 'go'
    park: (id: string, origin: string, epoch: string) => Promise<ParkResult>
    gone: Set<string>
    /** Throw this from `connectExplicit` instead of returning a binding. */
    connectError?: unknown
    connected: ExplicitConnectInput[]
    opened: { epoch: string; origin: string; secret: Uint8Array }[]
    /** RPC knobs (Task 8). Unset keeps the Task 6 and 7 rule that dispatch is not available. */
    dispatch?: typeof dispatchFn
    /** Tokens waiting for the next response of an epoch; cleared by `confirmWritten`, as the real outbox does. */
    tokens: Map<string, string>
    inFlightNow: Map<string, number>
    touched: string[]
  }
  /** Set by `opts.realRegistry`: resolves once the registry has loaded. */
  ready: Promise<void>
  handle(req: Partial<RawRequest> & { target: string }): Promise<RoutePlan>
}

export function makeHarness(
  opts: { routes?: Partial<Record<RouteKind, RouteHandler>>; realRegistry?: boolean; identity?: ContinuityHandle } = {}
): Harness {
  const identity = opts.identity ?? identityHandle
  const secrets = new Map<string, Uint8Array>()
  const origins = new Map<string, string>()
  const kv = new Map<string, string>()
  const realRegistry = opts.realRegistry
    ? createBindingRegistry({
        tombstoneStorage: {
          getItem: async k => kv.get(k) ?? null,
          setItem: async (k, v) => void kv.set(k, v),
          removeItem: async k => void kv.delete(k),
          getAllKeys: async () => [...kv.keys()]
        },
        now: () => Date.now(),
        onClosed: () => {}
      })
    : undefined
  const calls: string[] = []
  const state: Harness['state'] = {
    bound: { port: PORT, ipv4: true, ipv6: true },
    allowLocalhostHttp: false,
    records: [],
    snapshotCalls: 0,
    used: new Set(),
    gateBusy: new Set(),
    readiness: 'go',
    park: async () => 'resume',
    gone: new Set(),
    connected: [],
    opened: [],
    tokens: new Map(),
    inFlightNow: new Map(),
    touched: []
  }
  const rec = (name: string) => calls.push(name)
  const env: RouterEnv = {
    transportId: 'android-loopback',
    bound: () => state.bound,
    identity: async () => {
      rec('identity')
      return identity
    },
    descriptorBase: {
      name: 'Bitcoin SV Wallet',
      vendor: 'org.bsvblockchain.wallet',
      instanceLabel: 'Bitcoin SV Wallet'
    },
    launches: {
      matchHello: p => {
        rec('launches.matchHello')
        return state.records.find(
          r => helloMac(r.k, { origin: p.origin, challenge: p.challenge, host: p.host }) === p.hello
        )
      },
      take: epoch => {
        rec('launches.take')
        const r = state.records.find(x => x.epoch === epoch)
        if (!r || state.used.has(epoch)) return undefined
        state.used.add(epoch)
        return r
      }
    },
    unsettledGate: {
      check: origin => (rec('gate.check'), !state.gateBusy.has(origin)),
      claim: origin => (rec('gate.claim'), state.gateBusy.add(origin)),
      release: () => rec('gate.release')
    },
    tokenOutbox: {
      take: epoch => (rec('outbox.take'), state.tokens.get(epoch)),
      confirmWritten: epoch => (rec('outbox.confirmWritten'), state.tokens.delete(epoch)),
      drop: epoch => (rec('outbox.drop'), state.tokens.delete(epoch))
    },
    session: {
      readiness: () => (rec('session.readiness'), state.readiness),
      parkConnect: (id, origin, epoch) => (rec('session.parkConnect'), state.park(id, origin, epoch)),
      onConnect: () => rec('session.onConnect'),
      onBindingClosed: () => rec('session.onBindingClosed')
    },
    ledger: {
      open: (epoch, origin, secret) => {
        rec('ledger.open')
        state.opened.push({ epoch, origin, secret })
        secrets.set(epoch, secret)
        origins.set(epoch, origin)
      },
      secret: epoch => (rec('ledger.secret'), secrets.get(epoch)),
      origin: epoch => (rec('ledger.origin'), origins.get(epoch)),
      touch: epoch => (rec('ledger.touch'), state.touched.push(epoch)),
      inFlight: (epoch, delta) => {
        rec('ledger.inFlight')
        state.inFlightNow.set(epoch, (state.inFlightNow.get(epoch) ?? 0) + delta)
      },
      parked: () => rec('ledger.parked'),
      markSettled: () => rec('ledger.markSettled'),
      isSettled: () => (rec('ledger.isSettled'), false),
      markGone: () => rec('ledger.markGone'),
      isGone: id => (rec('ledger.isGone'), state.gone.has(id)),
      clearGone: id => (rec('ledger.clearGone'), state.gone.delete(id)),
      idleSince: () => (rec('ledger.idleSince'), undefined),
      epochsForOrigin: () => (rec('ledger.epochsForOrigin'), []),
      close: epoch => {
        rec('ledger.close')
        secrets.delete(epoch)
        origins.delete(epoch)
      }
    },
    registry:
      realRegistry ??
      new Proxy({} as RouterEnv['registry'], {
        get: (_t, name) => () => {
          rec(`registry.${String(name)}`)
          throw new Error('registry is not available in this test')
        }
      }),
    connectExplicit: input => {
      rec('connectExplicit')
      if (state.connectError !== undefined) throw state.connectError
      state.connected.push(input)
      if (realRegistry) return realRegistry.connectExplicit(input)
      return { epoch: input.epoch, state: 'live' } as unknown as ReturnType<RouterEnv['connectExplicit']>
    },
    snapshot: () => {
      state.snapshotCalls++
      if (!state.snapshot) throw new Error('snapshot must not be read')
      return state.snapshot as unknown as ReturnType<RouterEnv['snapshot']>
    },
    // Not async on purpose: a synchronous throw from `dispatch` must be observable by the router.
    dispatch: ((input: Parameters<typeof dispatchFn>[0]) => {
      rec('dispatch')
      if (state.dispatch) return state.dispatch(input)
      throw new Error('dispatch is not available in this test')
    }) as typeof dispatchFn,
    allowLocalhostHttp: () => state.allowLocalhostHttp
  }
  const router = createLoopbackRouter(env, opts.routes)
  return {
    env,
    calls,
    state,
    ready: realRegistry ? realRegistry.load() : Promise.resolve(),
    handle: req =>
      router.handle({
        id: 'c1',
        method: 'GET',
        headers: [
          ['host', HOST4],
          ['origin', ORIGIN]
        ],
        body: '',
        ...req
      })
  }
}

/** A complete response; throws when the router held the socket open. */
export function done(plan: RoutePlan): RouteResponse {
  if (plan.kind !== 'respond') throw new Error('expected an immediate response')
  return { status: plan.status, headers: plan.headers, body: plan.body }
}

export function headerOf(r: RouteResponse, name: string): string | undefined {
  const lower = name.toLowerCase()
  return r.headers.find(([k]) => k.toLowerCase() === lower)?.[1]
}

export function describeTarget(extra = '', challenge = CHALLENGE): string {
  return `/.well-known/brc-wallet?challenge=${challenge}${extra}`
}
