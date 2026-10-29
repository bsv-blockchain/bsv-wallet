/**
 * The loopback router (spec 6.5): BRC-185 section 4.1 HTTP semantics over the ports in `routerTypes.ts`.
 * Pure TypeScript: Kotlin parses and writes HTTP, this decides what every request means.
 *
 * This file holds the entry point, the gate (path allowlist, Host, Origin, CORS, preflight) and describe.
 * Connect, RPC and disconnect are added by their own tasks and plug into `routes` below.
 *
 * Nothing here logs. `k`, epochs, proofs, acks, binding secrets, tokens and bodies are never written anywhere.
 */
import { b64uDecode } from '../protocol/base64url'
import { connectionError, type ConnectionError } from '../protocol/connectionError'
import { assertAdvertisesResponder, signDescribe, validateDescriptor, type Descriptor } from '../protocol/descriptor'
import { canonicalizeBridgeOrigin } from '../protocol/origin'
import { BASE_HEADERS, corsHeaders, preflightHeaders, type CorsKind } from './cors'
import { loopbackEndpoints } from './endpoints'
import { isAllowedHost } from './hostCheck'
import { describeAck } from './launchProof'
import type { RawRequest, RoutePlan, RouteResponse, RouterEnv, LoopbackRouter } from './routerTypes'
import { STATUS, statusForConnectionError } from './status'

const encoder = new TextEncoder()

/** A describe request carries no body of interest; anything over this is refused rather than buffered on. */
const MAX_DESCRIBE_BODY_BYTES = 16384
const EPOCH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const METHOD_SEGMENT_RE = /^[A-Za-z0-9]{1,64}$/
const DISCOVERY_PATH = '/.well-known/brc-wallet'
const CONNECT_PATH = '/.well-known/brc-wallet/connect'
const CONNECT_PREFIX = '/.well-known/brc-wallet/connect/'
const RPC_PREFIX = '/brc185/v1/rpc/'

export type RouteKind = 'describe' | 'connect' | 'disconnect' | 'rpc'

interface Matched {
  kind: RouteKind
  /** The epoch (disconnect) or method name (rpc) segment, literal. */
  segment?: string
  /** Raw query string without `?`, only ever non-empty for describe. */
  query: string
  allow: string
}

/** What a route handler gets once a request has passed the gate. */
export interface GateContext {
  env: RouterEnv
  req: RawRequest
  route: Matched
  /** The canonical request origin (passed step 2). */
  origin: string
  /** The request's own `Host` value (already checked against the bound set). */
  host: string
  header(name: string): string | undefined
}

export type RouteHandler = (ctx: GateContext) => Promise<RoutePlan>

function utf8Length(s: string): number {
  return encoder.encode(s).length
}

function respond(status: number, headers: [string, string][], body: string): RoutePlan {
  return { kind: 'respond', status, headers, body }
}

/** Base headers on every response, errors included (spec 6.6.1). */
function base(extra: [string, string][] = []): [string, string][] {
  return [...BASE_HEADERS.map(h => [h[0], h[1]] as [string, string]), ...extra]
}

function emptyResponse(status: number, extra: [string, string][] = []): RoutePlan {
  return respond(status, base(extra), '')
}

function jsonHeaders(extra: [string, string][]): [string, string][] {
  return base([['Content-Type', 'application/json'], ...extra])
}

export function errorResponse(
  e: ConnectionError,
  opts: { situation?: keyof typeof STATUS; cors?: [string, string][]; headers?: [string, string][] } = {}
): RoutePlan {
  const status = statusForConnectionError(e, opts.situation)
  return respond(status, jsonHeaders([...(opts.cors ?? []), ...(opts.headers ?? [])]), JSON.stringify(e))
}

export function plan(r: RouteResponse): RoutePlan {
  return { kind: 'respond', ...r }
}

function protocolError(message: string, cors: [string, string][] = []): RoutePlan {
  return errorResponse(connectionError('PROTOCOL_ERROR', message, 'not-sent'), { cors })
}

function internalError(cors: [string, string][] = []): RoutePlan {
  return errorResponse(connectionError('CONFIGURATION_ERROR', 'Internal error', 'not-sent'), {
    situation: 'internal',
    cors
  })
}

/**
 * Step 1. The target is matched literally: no decoding, no normalisation. Anything with a percent escape, a
 * fragment, a dot segment, an absolute form or a non-canonical epoch is simply not on the list.
 */
function matchTarget(target: string): Matched | undefined {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return undefined
  if (target.includes('%') || target.includes('#') || target.includes('\\')) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-￿]/.test(target)) return undefined
  const q = target.indexOf('?')
  const path = q === -1 ? target : target.slice(0, q)
  const query = q === -1 ? '' : target.slice(q + 1)
  if (path.split('/').some(s => s === '.' || s === '..')) return undefined
  if (path === DISCOVERY_PATH) return { kind: 'describe', query, allow: 'GET, OPTIONS' }
  if (query !== '' || q !== -1) return undefined
  if (path === CONNECT_PATH) return { kind: 'connect', query, allow: 'POST, OPTIONS' }
  if (path.startsWith(CONNECT_PREFIX)) {
    const epoch = path.slice(CONNECT_PREFIX.length)
    return EPOCH_RE.test(epoch) ? { kind: 'disconnect', segment: epoch, query, allow: 'DELETE, OPTIONS' } : undefined
  }
  if (path.startsWith(RPC_PREFIX)) {
    const name = path.slice(RPC_PREFIX.length)
    return METHOD_SEGMENT_RE.test(name) ? { kind: 'rpc', segment: name, query, allow: 'POST, OPTIONS' } : undefined
  }
  return undefined
}

function verbFor(kind: RouteKind): string {
  return kind === 'describe' ? 'GET' : kind === 'disconnect' ? 'DELETE' : 'POST'
}

/** Header lookup over the lowercased pairs: the value when the name appears exactly once, else `undefined`. */
function only(headers: [string, string][], name: string): string | undefined {
  let found: string | undefined
  let n = 0
  for (const [k, v] of headers) {
    if (k === name) {
      n++
      found = v
    }
  }
  return n === 1 ? found : undefined
}

function count(headers: [string, string][], name: string): number {
  let n = 0
  for (const [k] of headers) if (k === name) n++
  return n
}

/** Parse `a=b&c=d` where every name may appear at most once and only `allowed` names are legal. */
function parseQuery(query: string, allowed: string[]): Map<string, string> | undefined {
  const out = new Map<string, string>()
  if (query === '') return out
  for (const part of query.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) return undefined
    const name = part.slice(0, eq)
    if (!allowed.includes(name) || out.has(name)) return undefined
    out.set(name, part.slice(eq + 1))
  }
  return out
}

function canonicalB64u32(s: string | undefined): string | undefined {
  if (s === undefined || s === '') return undefined
  try {
    return b64uDecode(s).length === 32 ? s : undefined
  } catch {
    return undefined
  }
}

/** Public CORS (discovery, connect, preflight): any origin that passed the gate. */
export function publicCors(origin: string): [string, string][] {
  return corsHeaders({ origin, kind: 'public' as CorsKind })
}

async function describe(ctx: GateContext): Promise<RoutePlan> {
  const { env, req, origin, host } = ctx
  const cors = publicCors(origin)
  if (utf8Length(req.body) > MAX_DESCRIBE_BODY_BYTES) {
    return errorResponse(connectionError('RESOURCE_LIMIT', 'Request body is too large', 'not-sent'), {
      situation: 'bodyTooLarge',
      cors
    })
  }
  const q = parseQuery(ctx.route.query, ['challenge', 'hello'])
  if (!q) return protocolError('Unknown or repeated query parameter', cors)
  const challenge = canonicalB64u32(q.get('challenge'))
  if (challenge === undefined) return protocolError('challenge must be 32 bytes of canonical base64url', cors)
  let hello: string | undefined
  if (q.has('hello')) {
    hello = canonicalB64u32(q.get('hello'))
    if (hello === undefined) return protocolError('hello must be 32 bytes of canonical base64url', cors)
  }

  const identity = await env.identity(origin)
  const raw: Record<string, unknown> = {
    version: 1,
    instanceId: identity.instanceId,
    name: env.descriptorBase.name,
    instanceLabel: env.descriptorBase.instanceLabel,
    vendor: env.descriptorBase.vendor,
    continuityKey: identity.continuityKey,
    endpoints: loopbackEndpoints(env.bound())
  }
  if (env.descriptorBase.icon !== undefined) raw.icon = env.descriptorBase.icon
  // Refuse to sign a descriptor the page would refuse, and one that does not name the endpoint that answered.
  let descriptor: Descriptor
  try {
    descriptor = validateDescriptor(raw)
    assertAdvertisesResponder(descriptor, { type: 'http-json', address: `http://${host}` })
  } catch {
    return internalError(cors)
  }
  // Sign the raw object: the page's signature check runs over exactly what was sent.
  const signed = await signDescribe(identity, { origin, challenge, descriptor: raw as unknown as Descriptor })

  const headers = jsonHeaders(cors)
  if (hello !== undefined) {
    const record = env.launches.matchHello({ hello, origin, challenge, host })
    if (record) {
      const ack = describeAck(record.k, {
        wallet: { instanceId: identity.instanceId, continuityKey: identity.continuityKey },
        origin,
        challenge,
        host,
        nonce: record.n
      })
      headers.push(['BRC-185-Android-Ack', ack])
    }
  }
  return respond(STATUS.ok, headers, JSON.stringify(signed))
}

async function notYet(ctx: GateContext): Promise<RoutePlan> {
  // Connect, RPC and disconnect are implemented by the connect and RPC tasks; until then the gate answers them
  // with an internal error rather than pretending to serve them.
  return internalError(ctx.route.kind === 'connect' ? publicCors(ctx.origin) : [])
}

export const defaultRoutes: Record<RouteKind, RouteHandler> = {
  describe,
  connect: notYet,
  disconnect: notYet,
  rpc: notYet
}

export function createLoopbackRouter(
  env: RouterEnv,
  routes: Partial<Record<RouteKind, RouteHandler>> = {}
): LoopbackRouter {
  const handlers = { ...defaultRoutes, ...routes }

  async function route(req: RawRequest): Promise<RoutePlan> {
    // Host: Kotlin checked it; the router checks it again against the same bound set. Exactly one, exact match.
    if (count(req.headers, 'host') !== 1 || !isAllowedHost(only(req.headers, 'host'), env.bound())) {
      return emptyResponse(STATUS.forbidden)
    }
    const host = only(req.headers, 'host') as string

    // Step 1: path allowlist, then verb. No CORS on either.
    const matched = matchTarget(req.target)
    if (!matched) return emptyResponse(STATUS.notFound)
    const verb = verbFor(matched.kind)
    if (req.method !== verb && req.method !== 'OPTIONS') {
      return emptyResponse(STATUS.methodNotAllowed, [['Allow', matched.allow]])
    }

    // Step 2: Origin present exactly once and canonical. Refusals say nothing, with no CORS.
    if (count(req.headers, 'origin') !== 1) return emptyResponse(STATUS.forbidden)
    let origin: string
    try {
      const value = only(req.headers, 'origin') as string
      origin = canonicalizeBridgeOrigin({
        origin: value,
        attestation: 'unattested',
        allowLocalhostHttp: env.allowLocalhostHttp()
      }).applicationOrigin
    } catch {
      return emptyResponse(STATUS.forbidden)
    }
    // The origin is never taken from a header the page can set freely. No CORS: no page is meant to send these.
    if (count(req.headers, 'originator') > 0 || count(req.headers, 'brc-185-context') > 0) {
      return protocolError('Originator and BRC-185-Context headers are not accepted')
    }

    // Step 4: preflight. Noninteractive, touches no state; CORS for any origin that passed step 2.
    if (req.method === 'OPTIONS') {
      return respond(
        STATUS.noContent,
        preflightHeaders({
          origin,
          requestHeaders: only(req.headers, 'access-control-request-headers'),
          privateNetwork: only(req.headers, 'access-control-request-private-network') === 'true'
        }),
        ''
      )
    }

    return handlers[matched.kind]({
      env,
      req,
      route: matched,
      origin,
      host,
      header: name => only(req.headers, name.toLowerCase())
    })
  }

  return {
    async handle(req) {
      try {
        return await route(req)
      } catch {
        // Nothing here has started a dispatch yet, so the wallet never saw the call.
        return internalError()
      }
    }
  }
}
