/**
 * The transport-independent conformance cases (spec 6.14 item 7, "Shared conformance cases"): all 28 methods
 * round-trip, wallet errors map to `WireError`, and the request and response size caps. A transport's tests run
 * them against its own executor through `CaseContext.call`, so the HTTP router (Android) and any later transport
 * share one definition. The HTTP-only cases (status table, CORS, Host check) stay in the router tests.
 *
 * Contract of the wallet under test (the executor wires its fake wallet this way):
 * - every method answers `{ echo: <method> }`;
 * - `{ __fail: kind }` makes the wallet throw: `invalid-parameter` (a `WERR_INVALID_PARAMETER`), `insufficient-funds`
 *   (`WERR_INSUFFICIENT_FUNDS`), `hmac` (`code: 'ERR_INVALID_HMAC'`), `signature` (`code: 'ERR_INVALID_SIGNATURE'`),
 *   `unknown` (a plain `Error`);
 * - `{ __respondBytes: n }` makes the wallet answer a string of `n` characters.
 *
 * `call` returns the dispatcher `Outcome`, or an `HttpResult` when the executor is an HTTP responder. For an
 * `HttpResult` the cases read the JSON body, not the status: a body with `isError: true` is a wallet error, a
 * body with `domain: 'brc185'` is a connection error, anything else is the result.
 */
import type { Outcome } from '../dispatcher'
import { MAX_BRIDGE_REQUEST_BYTES } from '../protocol/limits'
import { BRIDGE_METHODS, type WalletMethodName } from '../protocol/methods'
import type { ConnectionErrorCode, Delivery } from '../protocol/connectionError'
import type { WireError } from '../protocol/errorCodec'

export type { Outcome }

export interface HttpResult {
  status: number
  headers: [string, string][]
  body: string
}

export interface CaseContext {
  call(method: string, args: unknown): Promise<Outcome | HttpResult>
}

export interface ConformanceCase {
  id: string
  method?: WalletMethodName
  /** Throws on failure. */
  run(ctx: CaseContext): Promise<void>
}

type Normalised =
  | { kind: 'ok'; result: unknown }
  | { kind: 'wallet'; wire: Partial<WireError> }
  | { kind: 'connection'; code: ConnectionErrorCode; delivery?: Delivery }

function isHttp(r: Outcome | HttpResult): r is HttpResult {
  return typeof (r as HttpResult).status === 'number' && typeof (r as HttpResult).body === 'string'
}

function normalise(r: Outcome | HttpResult): Normalised {
  if (!isHttp(r)) {
    if (r.ok) return { kind: 'ok', result: r.result }
    if ('walletError' in r) return { kind: 'wallet', wire: r.walletError }
    return { kind: 'connection', code: r.connectionError.code, delivery: r.connectionError.delivery }
  }
  let body: unknown
  try {
    body = JSON.parse(r.body)
  } catch {
    throw new Error(`HTTP ${r.status} body is not JSON`)
  }
  const o = body as Record<string, unknown> | null
  if (o !== null && typeof o === 'object') {
    if (o.isError === true) return { kind: 'wallet', wire: o as Partial<WireError> }
    if (o.domain === 'brc185') {
      return { kind: 'connection', code: o.code as ConnectionErrorCode, delivery: o.delivery as Delivery | undefined }
    }
  }
  if (r.status < 200 || r.status > 299)
    throw new Error(`HTTP ${r.status} with a body that is neither a wire nor a connection error`)
  return { kind: 'ok', result: body }
}

function fail(msg: string): never {
  throw new Error(msg)
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const methodCases: ConformanceCase[] = (Object.keys(BRIDGE_METHODS) as WalletMethodName[]).map(method => ({
  id: `method:${method}`,
  method,
  async run(ctx) {
    const n = normalise(await ctx.call(method, {}))
    if (n.kind !== 'ok') fail(`${method}: expected a result, got ${JSON.stringify(n)}`)
    if (!sameJson(n.result, { echo: method })) fail(`${method}: result did not round-trip: ${JSON.stringify(n.result)}`)
  }
}))

const ERROR_KINDS: Array<{ kind: string; code: number; name: string }> = [
  { kind: 'invalid-parameter', code: 6, name: 'WERR_INVALID_PARAMETER' },
  { kind: 'insufficient-funds', code: 7, name: 'WERR_INSUFFICIENT_FUNDS' },
  { kind: 'hmac', code: 3, name: 'ERR_INVALID_HMAC' },
  { kind: 'signature', code: 4, name: 'ERR_INVALID_SIGNATURE' },
  { kind: 'unknown', code: 1, name: 'WERR_UNKNOWN' }
]

const errorCases: ConformanceCase[] = ERROR_KINDS.map(({ kind, code, name }) => ({
  id: `error-codec:${kind}`,
  async run(ctx) {
    const n = normalise(await ctx.call('getPublicKey', { __fail: kind }))
    if (n.kind !== 'wallet') fail(`${kind}: expected a wallet error, got ${JSON.stringify(n)}`)
    if (n.wire.isError !== true || n.wire.code !== code || n.wire.name !== name) {
      fail(`${kind}: expected wire code ${code} ${name}, got ${JSON.stringify(n.wire)}`)
    }
    const msg = n.wire.message
    if (typeof msg !== 'string' || msg.includes('\n    at ')) fail(`${kind}: wire message missing or carries a stack`)
  }
}))

const capCases: ConformanceCase[] = [
  {
    id: 'request-cap:over',
    async run(ctx) {
      const n = normalise(await ctx.call('listActions', { pad: 'a'.repeat(MAX_BRIDGE_REQUEST_BYTES + 1) }))
      if (n.kind !== 'connection' || n.code !== 'RESOURCE_LIMIT')
        fail(`expected RESOURCE_LIMIT, got ${JSON.stringify(n)}`)
      if (n.delivery !== undefined && n.delivery !== 'not-sent') fail('an over-cap request must be not-sent')
    }
  },
  {
    id: 'response-cap:over',
    async run(ctx) {
      const n = normalise(await ctx.call('listActions', { __respondBytes: MAX_BRIDGE_REQUEST_BYTES + 1 }))
      if (n.kind !== 'connection' || n.code !== 'RESOURCE_LIMIT')
        fail(`expected RESOURCE_LIMIT, got ${JSON.stringify(n)}`)
      if (n.delivery !== undefined && n.delivery !== 'unknown') fail('an over-cap response must be delivery unknown')
    }
  },
  {
    id: 'response-cap:under',
    async run(ctx) {
      const n = normalise(await ctx.call('listActions', { __respondBytes: 1024 }))
      if (n.kind !== 'ok' || typeof n.result !== 'string' || n.result.length !== 1024) {
        fail(`a small response must pass through, got ${JSON.stringify(n).slice(0, 200)}`)
      }
    }
  }
]

export const TRANSPORT_INDEPENDENT_CASES: ReadonlyArray<ConformanceCase> = Object.freeze([
  ...methodCases,
  ...errorCases,
  ...capCases
])
