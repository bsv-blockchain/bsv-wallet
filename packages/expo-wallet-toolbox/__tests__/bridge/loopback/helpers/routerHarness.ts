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
import { helloMac } from '../../../../core/bridge/loopback/launchProof'
import {
  createLoopbackRouter,
  type LaunchRecordView,
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
  }
  handle(req: Partial<RawRequest> & { target: string }): Promise<RoutePlan>
}

export function makeHarness(opts: { routes?: Partial<Record<RouteKind, RouteHandler>> } = {}): Harness {
  const calls: string[] = []
  const state: Harness['state'] = {
    bound: { port: PORT, ipv4: true, ipv6: true },
    allowLocalhostHttp: false,
    records: [],
    snapshotCalls: 0
  }
  const rec = (name: string) => calls.push(name)
  const env: RouterEnv = {
    transportId: 'android-loopback',
    bound: () => state.bound,
    identity: async () => {
      rec('identity')
      return identityHandle
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
      take: () => {
        rec('launches.take')
        return undefined
      }
    },
    unsettledGate: {
      check: () => (rec('gate.check'), true),
      claim: () => rec('gate.claim'),
      release: () => rec('gate.release')
    },
    tokenOutbox: {
      take: () => (rec('outbox.take'), undefined),
      confirmWritten: () => rec('outbox.confirmWritten'),
      drop: () => rec('outbox.drop')
    },
    session: {
      readiness: () => (rec('session.readiness'), 'go'),
      parkConnect: async () => (rec('session.parkConnect'), 'resume'),
      onConnect: () => rec('session.onConnect'),
      onBindingClosed: () => rec('session.onBindingClosed')
    },
    ledger: {
      open: () => rec('ledger.open'),
      secret: () => (rec('ledger.secret'), undefined),
      origin: () => (rec('ledger.origin'), undefined),
      touch: () => rec('ledger.touch'),
      inFlight: () => rec('ledger.inFlight'),
      parked: () => rec('ledger.parked'),
      markSettled: () => rec('ledger.markSettled'),
      isSettled: () => (rec('ledger.isSettled'), false),
      markGone: () => rec('ledger.markGone'),
      isGone: () => (rec('ledger.isGone'), false),
      clearGone: () => rec('ledger.clearGone'),
      idleSince: () => (rec('ledger.idleSince'), undefined),
      epochsForOrigin: () => (rec('ledger.epochsForOrigin'), []),
      close: () => rec('ledger.close')
    },
    registry: new Proxy({} as RouterEnv['registry'], {
      get: (_t, name) => () => {
        rec(`registry.${String(name)}`)
        throw new Error('registry is not available in this test')
      }
    }),
    connectExplicit: () => {
      rec('connectExplicit')
      throw new Error('connectExplicit is not available in this test')
    },
    snapshot: () => {
      state.snapshotCalls++
      throw new Error('snapshot must not be read')
    },
    dispatch: async () => {
      rec('dispatch')
      throw new Error('dispatch is not available in this test')
    },
    allowLocalhostHttp: () => state.allowLocalhostHttp
  }
  const router = createLoopbackRouter(env, opts.routes)
  return {
    env,
    calls,
    state,
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
