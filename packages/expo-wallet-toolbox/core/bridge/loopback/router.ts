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
import { connectionError, isConnectionError, type ConnectionError } from '../protocol/connectionError'
import {
  assertAdvertisesResponder,
  signConnect,
  signDescribe,
  validateDescriptor,
  type Descriptor
} from '../protocol/descriptor'
import { parseStrictJson } from '../protocol/json'
import type { ContinuityHandle } from '../protocol/continuity'
import { canonicalizeBridgeOrigin } from '../protocol/origin'
import { BASE_HEADERS, corsHeaders, preflightHeaders, type CorsKind } from './cors'
import { loopbackEndpoints } from './endpoints'
import { isAllowedHost } from './hostCheck'
import { bindingSecret, connectAck, describeAck, launchProof, timingSafeEqualB64u } from './launchProof'
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

/**
 * The descriptor this wallet advertises to one origin. Refuses to produce one the page would refuse, or one that
 * does not name the endpoint that answered. `raw` is what gets signed: the page's check runs over exactly what was sent.
 */
function buildDescriptor(env: RouterEnv, identity: ContinuityHandle, host: string): { raw: Descriptor } | undefined {
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
  try {
    const descriptor = validateDescriptor(raw)
    assertAdvertisesResponder(descriptor, { type: 'http-json', address: `http://${host}` })
  } catch {
    return undefined
  }
  return { raw: raw as unknown as Descriptor }
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
  const built = buildDescriptor(env, identity, host)
  if (!built) return internalError(cors)
  const { raw } = built
  // Sign the raw object: the page's signature check runs over exactly what was sent.
  const signed = await signDescribe(identity, { origin, challenge, descriptor: raw })

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

const CONNECT_MAX_BODY_BYTES = 4096
const CONNECT_MEMBERS = ['epoch', 'challenge', 'instanceId', 'continuityKey', 'android']
const ANDROID_MEMBERS = ['launchProof', 'reconnectToken']
const LAUNCH_PROOF_MESSAGE = 'launch proof required'

interface ConnectBody {
  epoch: string
  challenge: string
  instanceId: string
  continuityKey: string
  launchProof: string
  reconnectToken?: string
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Exactly the five members, no nulls, no extras; `android` holds `launchProof` and optionally `reconnectToken`. */
function parseConnectBody(text: string): ConnectBody | undefined {
  let v: unknown
  try {
    v = parseStrictJson(text)
  } catch {
    return undefined
  }
  if (!isPlainObject(v)) return undefined
  const keys = Object.keys(v)
  if (keys.length !== CONNECT_MEMBERS.length || !CONNECT_MEMBERS.every(k => keys.includes(k))) return undefined
  const { epoch, challenge, instanceId, continuityKey, android } = v
  if (typeof epoch !== 'string' || !EPOCH_RE.test(epoch)) return undefined
  if (canonicalB64u32(typeof challenge === 'string' ? challenge : undefined) === undefined) return undefined
  if (typeof instanceId !== 'string' || typeof continuityKey !== 'string') return undefined
  if (!isPlainObject(android)) return undefined
  const akeys = Object.keys(android)
  if (!akeys.every(k => ANDROID_MEMBERS.includes(k)) || !akeys.includes('launchProof')) return undefined
  const { launchProof: proof, reconnectToken } = android
  if (typeof proof !== 'string') return undefined
  if (akeys.includes('reconnectToken') && typeof reconnectToken !== 'string') return undefined
  const out: ConnectBody = {
    epoch,
    challenge: challenge as string,
    instanceId,
    continuityKey,
    launchProof: proof
  }
  if (typeof reconnectToken === 'string') out.reconnectToken = reconnectToken
  return out
}

/** A `respond` plan as a plain response (the connect continuation settles with responses, not plans). */
function asResponse(p: RoutePlan): RouteResponse {
  if (p.kind !== 'respond') throw new Error('expected an immediate response')
  return { status: p.status, headers: p.headers, body: p.body }
}

/**
 * Connect (spec 6.5 steps 5 to 8, 6.7, 7.5). Everything that can refuse runs before `connectExplicit`, which is
 * the last step of validation; the gate re-check, the snapshot read, `connectExplicit`, `ledger.open`,
 * `unsettledGate.claim` and `session.onConnect` then run in one synchronous turn (Review Focus 6).
 */
async function connect(ctx: GateContext): Promise<RoutePlan> {
  const { env, req, origin, host } = ctx
  const cors = publicCors(origin)
  const retry: [string, string][] = [['Retry-After', '5']]

  // 415 before anything is touched; exactly one Content-Type, exactly `application/json`.
  if (ctx.header('content-type') !== 'application/json') {
    return errorResponse(connectionError('PROTOCOL_ERROR', 'Content-Type must be application/json', 'not-sent'), {
      situation: 'unsupportedMediaType',
      cors
    })
  }
  if (utf8Length(req.body) > CONNECT_MAX_BODY_BYTES) {
    return errorResponse(connectionError('RESOURCE_LIMIT', 'Request body is too large', 'not-sent'), {
      situation: 'bodyTooLarge',
      cors
    })
  }
  const body = parseConnectBody(req.body)
  if (!body) return protocolError('Connect body is malformed', cors)

  // Identity for this origin must be the one the page pinned.
  const identity = await env.identity(origin)
  if (body.instanceId !== identity.instanceId || body.continuityKey !== identity.continuityKey) {
    return errorResponse(
      connectionError('PROVIDER_CHANGED', 'Wallet identity changed', 'not-sent', { epoch: body.epoch }),
      { cors }
    )
  }
  const built = buildDescriptor(env, identity, host)
  if (!built) return internalError(cors)

  // Unsettled-binding gate, before the launch proof is burnt so a second tab can retry on the same launch.
  if (!env.unsettledGate.check(origin)) {
    return errorResponse(connectionError('RESOURCE_LIMIT', 'Another connection is awaiting approval', 'not-sent'), {
      cors,
      headers: retry
    })
  }

  // Launch proof: looked up and burnt at arrival, whatever the outcome. One fixed message for every cause.
  const record = env.launches.take(body.epoch)
  const message = record && {
    wallet: { instanceId: identity.instanceId, continuityKey: identity.continuityKey },
    epoch: body.epoch,
    origin,
    challenge: body.challenge,
    host,
    nonce: record.n
  }
  if (!record || !message || !timingSafeEqualB64u(body.launchProof, launchProof(record.k, message))) {
    return errorResponse(connectionError('CONFIGURATION_ERROR', LAUNCH_PROOF_MESSAGE, 'not-sent'), {
      situation: 'launchProof',
      cors
    })
  }
  const k = record.k

  const finish = async (): Promise<RouteResponse> => {
    // The page left while this connect waited: no binding for a request nobody is waiting on.
    if (env.ledger.isGone(req.id)) {
      env.ledger.clearGone(req.id)
      return asResponse(
        errorResponse(connectionError('CONNECTION_CLOSED', 'Client closed the connection', 'not-sent'), { cors })
      )
    }
    // Synchronous from here to `onConnect`: nothing between the gate check and the claim may yield.
    if (!env.unsettledGate.check(origin)) {
      return asResponse(
        errorResponse(connectionError('RESOURCE_LIMIT', 'Another connection is awaiting approval', 'not-sent'), {
          cors,
          headers: retry
        })
      )
    }
    const snap = env.snapshot()
    try {
      env.connectExplicit({
        epoch: body.epoch,
        transportId: env.transportId,
        applicationOrigin: origin,
        attestation: 'unattested',
        instanceId: identity.instanceId,
        continuityKey: identity.continuityKey,
        accountContext: snap.accountContext,
        walletRevision: snap.walletRevision,
        launchProofVerified: true,
        ...(body.reconnectToken !== undefined ? { reconnectToken: body.reconnectToken } : {})
      })
    } catch (e) {
      if (isConnectionError(e)) return asResponse(errorResponse(e, { cors }))
      return asResponse(internalError(cors))
    }
    const secret = bindingSecret(k, message)
    env.ledger.open(body.epoch, origin, b64uDecode(secret))
    env.unsettledGate.claim(origin, body.epoch)
    env.session.onConnect(body.epoch)

    try {
      const signed = await signConnect(identity, {
        origin,
        epoch: body.epoch,
        challenge: body.challenge,
        descriptor: built.raw
      })
      const headers = jsonHeaders(cors)
      headers.push(['BRC-185-Android-Ack', connectAck(k, message)])
      return { status: STATUS.ok, headers, body: JSON.stringify(signed) }
    } catch {
      // Signing failed after the binding exists: take it back so the page can start over.
      try {
        env.registry.close(body.epoch, 'disconnected')
      } catch {
        /* the registry already dropped it */
      }
      env.ledger.close(body.epoch)
      env.unsettledGate.release(body.epoch)
      env.session.onBindingClosed(body.epoch)
      return asResponse(internalError(cors))
    }
  }

  const guarded = async (): Promise<RouteResponse> => {
    try {
      return await finish()
    } catch {
      return asResponse(internalError(cors))
    }
  }

  const readiness = env.session.readiness()
  if (readiness === 'none-fail') {
    return errorResponse(connectionError('CONFIGURATION_ERROR', 'Wallet is not available', 'not-sent'), {
      situation: 'notBuilt',
      cors
    })
  }
  if (readiness === 'go') return plan(await guarded())

  // The wallet is not ready: hold the socket and wait to be released (or refused).
  const settled = env.session
    .parkConnect(req.id, origin, body.epoch)
    .then(async (result): Promise<RouteResponse> => {
      if (result === 'resume') return guarded()
      if (result === 'full') {
        return asResponse(
          errorResponse(connectionError('RESOURCE_LIMIT', 'Too many connections are waiting', 'not-sent'), { cors })
        )
      }
      return asResponse(
        errorResponse(connectionError('CONFIGURATION_ERROR', 'Wallet is not available', 'not-sent'), {
          situation: 'notBuilt',
          cors
        })
      )
    })
    .catch(() => asResponse(internalError(cors)))
  return { kind: 'hold', id: req.id, settled }
}

async function notYet(ctx: GateContext): Promise<RoutePlan> {
  // RPC and disconnect are implemented by the RPC task; until then the gate answers them
  // with an internal error rather than pretending to serve them.
  return internalError(ctx.route.kind === 'connect' ? publicCors(ctx.origin) : [])
}

export const defaultRoutes: Record<RouteKind, RouteHandler> = {
  describe,
  connect,
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
