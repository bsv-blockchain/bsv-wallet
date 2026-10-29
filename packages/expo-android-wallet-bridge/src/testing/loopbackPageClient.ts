/**
 * The stand-in page client for the Android loopback transport (spec 6.16, 7.7): what project 3's SDK will do, just
 * enough to drive the wallet from jest and from the demo page. It implements the toolbox `PageClient` plus the pieces
 * the page contract needs around it (`launch`, `permission`, `elicit`).
 *
 * The page contract it follows, in order: a user-gesture `launch()` navigates to the intent link; `discover()` scans
 * `127.0.0.1` ports with a fresh `challenge` and `hello` per attempt, verifies the describe proof, that the descriptor
 * names the responder that answered, and the describe acknowledgement under `k`, and stops at the FIRST endpoint whose
 * acknowledgement verifies. An endpoint that answers without a valid acknowledgement is `unauthenticated`: it is sent
 * nothing further (no epoch, launch proof or token). `connect()` goes to the authenticated endpoint only, verifies the
 * connect proof and acknowledgement, and only then pins the `continuityKey`. RPC and DELETE carry the binding secret
 * derived from `k`. A `412` means the binding is gone: reconnect from a new launch, never replay. Nothing is retried
 * after it was sent, and no legacy route is ever requested.
 *
 * Browser-safe: only the window and fetch it is given, `crypto.getRandomValues` and the toolbox's pure modules. It
 * never logs; `k`, the epoch, proofs, acknowledgements, the binding secret and tokens exist only in memory here.
 */
import type { WalletInterface } from '@bsv/sdk'
import { b64uEncode } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/base64url'
import {
  connectionError,
  type ConnectionErrorCode
} from '@bsv/expo-wallet-toolbox/core/bridge/protocol/connectionError'
import {
  assertAdvertisesResponder,
  verifyConnectProof,
  verifyDescribeProof,
  type Descriptor
} from '@bsv/expo-wallet-toolbox/core/bridge/protocol/descriptor'
import type { CloseReason } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import { decodeWireError } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/errorCodec'
import { CHALLENGE_BYTES, MAX_PROOF_RESPONSE_BYTES } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/limits'
import { BRIDGE_METHODS } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/methods'
import {
  bindingSecret,
  buildIntentLink,
  connectAck,
  describeAck,
  helloMac,
  launchProof,
  timingSafeEqualB64u,
  type LaunchMessage
} from '@bsv/expo-wallet-toolbox/core/bridge/loopback/launchProof'
import type {
  Connection,
  DiscoveredProvider,
  PageClient,
  RejectedProvider
} from '@bsv/expo-wallet-toolbox/core/bridge/testing/pageClient'

export type { Connection, DiscoveredProvider, PageClient, RejectedProvider }

export interface LoopbackFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  redirect?: 'error' | 'follow' | 'manual'
}

export interface LoopbackResponse {
  status: number
  ok: boolean
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type LoopbackFetch = (url: string, init?: LoopbackFetchInit) => Promise<LoopbackResponse>

export interface TokenStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface LoopbackWindow {
  location: { href: string; origin: string }
  crypto: { getRandomValues<T extends ArrayBufferView>(a: T): T }
  navigator?: { permissions?: { query(d: { name: string }): Promise<{ state: string }> } }
}

export interface LoopbackOptions {
  scheme: string
  packageId: string
  fallbackUrl?: string
  /** First port of the scan window. Default 3321. */
  basePort?: number
  /** Number of ports scanned, `basePort` upward. Default 64. */
  window?: number
  /** Deadline of each describe attempt: the wallet's JS may be busy loading. Default 3000 ms. */
  attemptTimeoutMs?: number
  /** Pause between scan rounds. Default 500 ms. */
  roundMs?: number
  /** Bound on the whole rediscovery after one click. Default 15000 ms. */
  totalMs?: number
  /** Attempts in flight at once. Default 16. */
  parallel?: number
  fetch: LoopbackFetch
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout?: (t: any) => void
  tokenStore: TokenStore
}

export type LoopbackPermission = 'granted' | 'prompt' | 'denied' | 'exempt' | 'unsupported'

export interface LoopbackPageClient extends PageClient {
  /** Build the intent link with a fresh epoch, `k` and `n` and navigate to it. Call from a user gesture, await nothing before it. */
  launch(): { epoch: string }
  permission(): Promise<LoopbackPermission>
  /** One eliciting request, no deadline: whatever it returns, Chrome has now asked (or refused) the permission. */
  elicit(): Promise<void>
}

/** What `DiscoveredProvider.handle` holds for this transport. Opaque to shared code. */
interface LoopbackHandle {
  host: string
  launch: Launch
}

interface Launch {
  epoch: string
  k: Uint8Array
  n: string
}

interface Live {
  host: string
  epoch: string
  instanceId: string
  continuityKey: string
  /** base64url binding secret, the value of `BRC-185-Android-Binding`. */
  secret: string
  dead: boolean
}

const DISCOVERY_PATH = '/.well-known/brc-wallet'
const ACK_HEADER = 'BRC-185-Android-Ack'
const TOKEN_HEADER = 'BRC-185-Reconnect-Token'
const PERMISSION_NAMES = ['loopback-network', 'local-network-access']
const LOOPBACK_ORIGINS = ['http://localhost', 'http://127.0.0.1', 'http://[::1]']

const tokenKey = (origin: string, continuityKey: string) => `brc185-android-token:${origin}:${continuityKey}`
const pinKey = (origin: string) => `brc185-android-pin:${origin}`

function fail(code: ConnectionErrorCode, message: string, delivery: 'not-sent' | 'unknown', epoch?: string): Error {
  return decodeWireError(connectionError(code, message, delivery, epoch === undefined ? {} : { epoch }))
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function createLoopbackPageClient(win: LoopbackWindow, opts: LoopbackOptions): LoopbackPageClient {
  const basePort = opts.basePort ?? 3321
  const windowSize = opts.window ?? 64
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 3000
  const roundMs = opts.roundMs ?? 500
  const totalMs = opts.totalMs ?? 15000
  const parallel = opts.parallel ?? 16
  const origin = win.location.origin
  const setT = opts.setTimeout
  const clearT = opts.clearTimeout ?? ((t: any) => clearTimeout(t))

  let pending: Launch | undefined

  const random = (n: number): Uint8Array => win.crypto.getRandomValues(new Uint8Array(n))
  const uuid = (): string => {
    const b = random(16)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  const sleep = (ms: number) => new Promise<void>(resolve => setT(resolve, ms))

  function launch(): { epoch: string } {
    const next: Launch = { epoch: uuid(), k: random(32), n: b64uEncode(random(16)) }
    const href = buildIntentLink({
      scheme: opts.scheme,
      packageId: opts.packageId,
      epoch: next.epoch,
      k: next.k,
      n: next.n,
      ...(opts.fallbackUrl !== undefined ? { fallbackUrl: opts.fallbackUrl } : {})
    })
    pending = next
    win.location.href = href
    return { epoch: next.epoch }
  }

  async function permission(): Promise<LoopbackPermission> {
    // BRC-325: a loopback http origin needs no permission.
    if (LOOPBACK_ORIGINS.includes(origin.replace(/:\d+$/, ''))) return 'exempt'
    const query = win.navigator?.permissions?.query
    if (!query) return 'unsupported'
    for (const name of PERMISSION_NAMES) {
      try {
        const status = await win.navigator!.permissions!.query({ name })
        if (status.state === 'granted' || status.state === 'prompt' || status.state === 'denied') return status.state
        return 'unsupported'
      } catch {
        /* this name is not known to the browser: try the next */
      }
    }
    return 'unsupported'
  }

  async function elicit(): Promise<void> {
    const challenge = b64uEncode(random(CHALLENGE_BYTES))
    try {
      await opts.fetch(`http://127.0.0.1:${basePort}${DISCOVERY_PATH}?challenge=${challenge}`, { redirect: 'error' })
    } catch {
      /* almost certainly nothing is listening; the permission has been decided either way */
    }
  }

  type Attempt =
    | { kind: 'absent' }
    | { kind: 'refused'; reason: string }
    | { kind: 'unauthenticated' }
    | { kind: 'ok'; host: string; descriptor: Descriptor }

  async function attempt(l: Launch, port: number, stop: AbortSignal): Promise<Attempt> {
    const host = `127.0.0.1:${port}`
    const challenge = b64uEncode(random(CHALLENGE_BYTES))
    const hello = helloMac(l.k, { origin, challenge, host })
    const ctl = new AbortController()
    const timer = setT(() => ctl.abort(), attemptTimeoutMs)
    const onStop = () => ctl.abort()
    stop.addEventListener('abort', onStop, { once: true })
    try {
      let res: LoopbackResponse
      let text: string
      try {
        res = await opts.fetch(`http://${host}${DISCOVERY_PATH}?challenge=${challenge}&hello=${hello}`, {
          redirect: 'error',
          signal: ctl.signal
        })
        text = await res.text()
      } catch {
        return { kind: 'absent' }
      }
      if (res.status !== 200 || text.length > MAX_PROOF_RESPONSE_BYTES)
        return { kind: 'refused', reason: 'not a wallet response' }
      let descriptor: Descriptor
      try {
        descriptor = verifyDescribeProof(parseJson(text), { origin, challenge })
        assertAdvertisesResponder(descriptor, { type: 'http-json', address: `http://${host}` })
      } catch (e) {
        return { kind: 'refused', reason: e instanceof Error ? e.message : 'describe proof failed' }
      }
      const ack = res.headers.get(ACK_HEADER)
      const expected = describeAck(l.k, {
        wallet: { instanceId: descriptor.instanceId, continuityKey: descriptor.continuityKey },
        origin,
        challenge,
        host,
        nonce: l.n
      })
      if (ack === null || !timingSafeEqualB64u(ack, expected)) return { kind: 'unauthenticated' }
      return { kind: 'ok', host, descriptor }
    } finally {
      clearT(timer)
      stop.removeEventListener('abort', onStop)
    }
  }

  async function discover(): Promise<{ providers: DiscoveredProvider[]; rejected: RejectedProvider[] }> {
    const l = pending
    if (!l) throw fail('CONFIGURATION_ERROR', 'launch() must be called from a user gesture first', 'not-sent')
    const rejected: RejectedProvider[] = []
    const reject = (reason: string) => rejected.push({ requestId: l.epoch, reason })

    if ((await permission()) === 'denied') {
      reject('blocked')
      return { providers: [], rejected }
    }

    const seen = new Map<string, string>()
    // Ends every attempt still open when discovery ends (a hung responder must not outlive the click).
    const stop = new AbortController()
    const startedAt = Date.now()
    let done = false
    let found: { host: string; descriptor: Descriptor } | undefined
    // Ports with an attempt still in flight. A responder that hangs holds one slot until the attempt deadline; it
    // neither blocks the next round nor gets a second attempt while the first is open.
    const inflight = new Set<number>()
    let active = 0
    let wake: (() => void) | undefined
    const poke = (): void => {
      const f = wake
      wake = undefined
      f?.()
    }
    const waitPoke = (ms: number): Promise<void> =>
      new Promise<void>(resolve => {
        const t = setT(() => {
          wake = undefined
          resolve()
        }, ms)
        wake = () => {
          clearT(t)
          resolve()
        }
      })

    const start = (port: number): void => {
      inflight.add(port)
      active++
      attempt(l, port, stop.signal)
        .then(
          r => {
            if (done) return
            const host = `127.0.0.1:${port}`
            if (r.kind === 'ok') {
              found = { host: r.host, descriptor: r.descriptor }
              done = true
            } else if (r.kind === 'unauthenticated') seen.set(host, 'unauthenticated')
            else if (r.kind === 'refused') seen.set(host, `refused: ${r.reason}`)
          },
          () => undefined
        )
        .finally(() => {
          inflight.delete(port)
          active--
          poke()
        })
    }

    const round = async (): Promise<void> => {
      const queue: number[] = []
      for (let i = 0; i < windowSize; i++) if (!inflight.has(basePort + i)) queue.push(basePort + i)
      while (!done && queue.length > 0) {
        while (!done && active < parallel && queue.length > 0) start(queue.shift() as number)
        if (done || queue.length === 0) break
        await waitPoke(attemptTimeoutMs + roundMs)
      }
      // Everything was asked: give the answers up to one round pause, then move on without waiting for stragglers.
      const until = Date.now() + roundMs
      while (!done && active > 0 && Date.now() < until) await waitPoke(until - Date.now())
    }

    while (!done) {
      await round()
      if (done) break
      if (Date.now() - startedAt + roundMs >= totalMs) break
      await sleep(roundMs)
    }
    done = true
    stop.abort()

    for (const reason of seen.values()) reject(reason)
    if (!found) {
      reject('wallet did not open')
      return { providers: [], rejected }
    }
    const handle: LoopbackHandle = { host: found.host, launch: l }
    return {
      providers: [{ requestId: l.epoch, handle, descriptor: found.descriptor }],
      rejected
    }
  }

  function readError(status: number, text: string, epoch: string, delivery: 'not-sent' | 'unknown'): Error {
    const body = parseJson(text)
    if (typeof body === 'object' && body !== null) return decodeWireError(body)
    return fail('PROTOCOL_ERROR', `Unexpected response (${status})`, delivery, epoch)
  }

  async function connect(provider: DiscoveredProvider, onClose?: (reason: CloseReason) => void): Promise<Connection> {
    void onClose // loopback HTTP has no server push: a closed binding shows up as a failed call (7.7 item 7)
    const { host, launch: l } = provider.handle as LoopbackHandle
    const d = provider.descriptor
    const challenge = b64uEncode(random(CHALLENGE_BYTES))
    const wallet = { instanceId: d.instanceId, continuityKey: d.continuityKey }
    const message: LaunchMessage = { wallet, epoch: l.epoch, origin, challenge, host, nonce: l.n }

    // A stored token is offered only to the endpoint whose key is the one already pinned for this origin.
    const pinned = opts.tokenStore.getItem(pinKey(origin))
    const stored = pinned === d.continuityKey ? opts.tokenStore.getItem(tokenKey(origin, d.continuityKey)) : null
    const android: Record<string, string> = { launchProof: launchProof(l.k, message) }
    if (stored !== null) android.reconnectToken = stored

    // The launch is single-use: whatever happens, a new click is needed to try again.
    if (pending === l) pending = undefined
    let res: LoopbackResponse
    let text: string
    try {
      res = await opts.fetch(`http://${host}/.well-known/brc-wallet/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epoch: l.epoch, challenge, ...wallet, android }),
        redirect: 'error'
      })
      text = await res.text()
    } catch {
      // Sent, outcome unknown: never retried here.
      throw Object.assign(fail('CONNECTION_CLOSED', 'The wallet did not answer', 'unknown', l.epoch), {
        newClick: true
      })
    }
    if (res.status !== 200) {
      const e = readError(res.status, text, l.epoch, 'not-sent') as Error & Record<string, unknown>
      e.newClick = true
      if (res.status === 429) {
        const header = res.headers.get('Retry-After')
        const seconds = header === null ? NaN : Number(header)
        // Retry-After is not CORS-exposed by the router, so a browser page usually cannot read it: 5 s is the value
        // the wallet's unsettled-binding gate and parked-connect cap use.
        e.retryAfterMs = (Number.isFinite(seconds) && seconds >= 0 ? seconds : 5) * 1000
      }
      throw e
    }

    let proven: Descriptor
    try {
      proven = verifyConnectProof(parseJson(text), {
        origin,
        epoch: l.epoch,
        challenge,
        expectedIdentity: wallet
      })
      assertAdvertisesResponder(proven, { type: 'http-json', address: `http://${host}` })
    } catch {
      throw Object.assign(fail('PROTOCOL_ERROR', 'Connect proof did not verify', 'unknown', l.epoch), {
        newClick: true
      })
    }
    const ack = res.headers.get(ACK_HEADER)
    if (ack === null || !timingSafeEqualB64u(ack, connectAck(l.k, message))) {
      throw Object.assign(fail('PROTOCOL_ERROR', 'Connect acknowledgement did not verify', 'unknown', l.epoch), {
        newClick: true
      })
    }
    // Verified: only now is the key pinned and the connection kept.
    opts.tokenStore.setItem(pinKey(origin), d.continuityKey)

    const live: Live = {
      host,
      epoch: l.epoch,
      instanceId: d.instanceId,
      continuityKey: d.continuityKey,
      secret: bindingSecret(l.k, message),
      dead: false
    }
    const closed: CloseReason[] = []
    const walletApi = new Proxy({} as WalletInterface, {
      get(_t, prop) {
        if (typeof prop !== 'string' || !Object.prototype.hasOwnProperty.call(BRIDGE_METHODS, prop)) return undefined
        return (args?: unknown) => rpc(live, prop, args)
      }
    })
    const connection: Connection = {
      epoch: l.epoch,
      provider,
      wallet: walletApi,
      closed,
      disconnect: () => disconnect(live)
    }
    return connection
  }

  const bindingHeaders = (live: Live, extra: Record<string, string> = {}): Record<string, string> => ({
    ...extra,
    'BRC-185-Epoch': live.epoch,
    'BRC-185-Instance': live.instanceId,
    'BRC-185-Key': live.continuityKey,
    'BRC-185-Android-Binding': live.secret
  })

  async function rpc(live: Live, method: string, args: unknown): Promise<unknown> {
    if (live.dead) {
      throw fail('CONNECTION_CLOSED', 'The connection is closed; open the wallet again', 'not-sent', live.epoch)
    }
    let res: LoopbackResponse
    let text: string
    try {
      res = await opts.fetch(`http://${live.host}/brc185/v1/rpc/${method}`, {
        method: 'POST',
        headers: bindingHeaders(live, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(args ?? {}),
        redirect: 'error'
      })
      text = await res.text()
    } catch {
      // A refusal without CORS (a retired binding) is indistinguishable from a dead wallet. Sent, so unknown, never replayed.
      live.dead = true
      throw fail('CONNECTION_CLOSED', 'The wallet did not answer', 'unknown', live.epoch)
    }
    // Any response of the authenticated binding may carry the next reconnect token, exposed to this origin only.
    const token = res.headers.get(TOKEN_HEADER)
    if (token !== null && token !== '') opts.tokenStore.setItem(tokenKey(origin, live.continuityKey), token)
    if (res.status === 412) {
      // The binding is gone. Reconnect from a new launch; never replay this call.
      live.dead = true
      throw Object.assign(readError(res.status, text, live.epoch, 'not-sent'), { newClick: true })
    }
    if (res.status === 410) live.dead = true
    if (res.status === 200) {
      const body = parseJson(text)
      if (body === undefined) throw fail('PROTOCOL_ERROR', 'Response is not valid JSON', 'unknown', live.epoch)
      return body
    }
    throw readError(res.status, text, live.epoch, 'unknown')
  }

  async function disconnect(live: Live): Promise<void> {
    if (live.dead) return
    live.dead = true
    try {
      await opts.fetch(`http://${live.host}/.well-known/brc-wallet/connect/${live.epoch}`, {
        method: 'DELETE',
        headers: bindingHeaders(live),
        redirect: 'error'
      })
    } catch {
      /* the wallet is gone or already closed it: the connection is closed either way */
    }
  }

  function invoke(connection: Connection, method: keyof WalletInterface, args: unknown = {}): Promise<unknown> {
    const fn = connection.wallet[method] as unknown as (a: unknown) => Promise<unknown>
    return fn.call(connection.wallet, args)
  }

  return { launch, permission, elicit, discover, connect, invoke }
}
