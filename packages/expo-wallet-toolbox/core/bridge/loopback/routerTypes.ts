/**
 * Port types of the loopback router (spec 6.5, 6.7). Defined once here: the router consumes them and the Android
 * kit's controller implements them. Type-only imports keep this file (and the loopback barrel) free of the
 * runtime, so the pure modules still bundle into the page-side stand-in client.
 */
import type { BindingRegistry } from '../bindings'
import type { dispatch } from '../dispatcher'
import type { ContinuityHandle } from '../protocol/continuity'
import type { BridgeSnapshot } from '../runtime'
import type { LoopbackBound } from './hostCheck'

/** One request as Kotlin hands it over. Header names are lowercased; `body` is the UTF-8 text of the body. */
export interface RawRequest {
  id: string
  method: string
  target: string
  headers: [string, string][]
  body: string
}

export interface RouteResponse {
  status: number
  headers: [string, string][]
  body: string
}

/** Answer now, or hold the socket open until `settled` resolves (RPC and parked connects). */
export type RoutePlan =
  | ({ kind: 'respond' } & RouteResponse)
  | { kind: 'hold'; id: string; settled: Promise<RouteResponse> }

/** A live launch record as the router sees it: plain data, no Buffer. `n` is base64url. */
export interface LaunchRecordView {
  epoch: string
  k: Uint8Array
  n: string
}

export interface HelloQuery {
  hello: string
  origin: string
  challenge: string
  host: string
}

export interface LaunchesPort {
  /** The live unused record whose hello MAC matches, if any. Consumes nothing. */
  matchHello(p: HelloQuery): LaunchRecordView | undefined
  /** Marks the record used before returning it; undefined if used, expired or unknown. */
  take(epoch: string): LaunchRecordView | undefined
}

export interface UnsettledGatePort {
  /** True when the origin has no unsettled binding, so a connect may proceed. */
  check(origin: string): boolean
  claim(origin: string, epoch: string): void
  release(epoch: string): void
}

export interface TokenOutboxPort {
  take(epoch: string): string | undefined
  confirmWritten(epoch: string): void
  drop(epoch: string): void
}

/** `unavailable` and `dropped` answer 503 CONFIGURATION_ERROR not-sent; `full` answers 429. */
export type ParkResult = 'resume' | 'unavailable' | 'dropped' | 'full'

export interface SessionPort {
  readiness(): 'park' | 'none-fail' | 'go'
  parkConnect(id: string, origin: string, epoch: string): Promise<ParkResult>
  onConnect(epoch: string): void
  onBindingClosed(epoch: string): void
}

/** The router consumes `secret`, `touch`, `inFlight` and `isGone`; the session and controller consume the rest. */
export interface BindingLedgerPort {
  /** Opens the epoch with `settled` false. */
  open(epoch: string, origin: string, secret: Uint8Array): void
  secret(epoch: string): Uint8Array | undefined
  origin(epoch: string): string | undefined
  touch(epoch: string): void
  inFlight(epoch: string, delta: 1 | -1): void
  parked(epoch: string, delta: 1 | -1): void
  markSettled(epoch: string): void
  isSettled(epoch: string): boolean
  markGone(connId: string): void
  isGone(connId: string): boolean
  clearGone(connId: string): void
  /** Undefined while parked or in flight. */
  idleSince(epoch: string): number | undefined
  epochsForOrigin(origin: string): string[]
  close(epoch: string): void
}

export interface RouterEnv {
  transportId: string
  bound(): LoopbackBound
  identity(origin: string): Promise<ContinuityHandle>
  descriptorBase: { name: string; vendor: string; icon?: string; instanceLabel: string }
  launches: LaunchesPort
  unsettledGate: UnsettledGatePort
  tokenOutbox: TokenOutboxPort
  session: SessionPort
  ledger: BindingLedgerPort
  registry: BindingRegistry
  connectExplicit: BindingRegistry['connectExplicit']
  snapshot(): BridgeSnapshot
  dispatch: typeof dispatch
  allowLocalhostHttp(): boolean
}

export interface LoopbackRouter {
  handle(req: RawRequest): Promise<RoutePlan>
}
