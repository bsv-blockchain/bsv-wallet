/**
 * Shared wiring for the stand-in page client tests: a page window whose `location.href` assignments are delivered to
 * the fake native module as Chrome would deliver an intent link, an in-memory HTTP layer with the REAL controller
 * mounted on it, and the squatter and relay fixtures. The router, launch registry, ledger and session under test are
 * the real ones (`bridgeHarness`); only the Kotlin module is faked.
 */
import { b64uEncode } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/base64url'
import { signDescribe, type Descriptor } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/descriptor'
import type { ContinuityHandle } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/continuity'
import { createSecureStoreContinuity } from '../src/continuity/secureStoreContinuity'
import { createInMemoryHttp, fromFakeNative, type MemoryHandler, type MemoryRequest } from '../src/testing/inMemoryHttp'
import {
  createLoopbackPageClient,
  type LoopbackOptions,
  type LoopbackPageClient,
  type LoopbackWindow,
  type TokenStore
} from '../src/testing/loopbackPageClient'
import { memorySecureStore, type Harness } from './bridgeHarness'

export const PAGE_ORIGIN = 'https://example.com'
export const SCHEME = 'bsv-wallet-bridge'

export function memoryTokenStore(): TokenStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

/** What Chrome does with `intent://launch?...#Intent;scheme=S;...;end`: start the app with `S://launch?...`. */
export function plainUriOfIntent(href: string): string {
  const m = /^intent:\/\/(launch\?[^#]*)#Intent;scheme=([^;]+);/.exec(href)
  if (!m) throw new Error('not a launch intent link')
  return `${m[2]}://${m[1]}`
}

export function secretsOfIntent(href: string): { epoch: string; k: string; n: string } {
  const q = new URLSearchParams(/\?([^#]*)#/.exec(href)![1])
  return { epoch: q.get('e')!, k: q.get('k')!, n: q.get('n')! }
}

export interface World {
  win: LoopbackWindow
  http: ReturnType<typeof createInMemoryHttp>
  /** Every URL the page fetched, mounted or not. */
  urls: string[]
  /** Every href the page navigated to. */
  hrefs: string[]
  tokenStore: ReturnType<typeof memoryTokenStore>
  opts: LoopbackOptions
  client(over?: Partial<LoopbackOptions>): LoopbackPageClient
  /** The real wallet, mounted at `127.0.0.1:<port>`. */
  mountWallet(h: Harness, port: number): { handler: MemoryHandler; dispose(): void }
  dispose(): void
}

export function createWorld(
  o: {
    origin?: string
    permissions?: (name: string) => Promise<{ state: string }>
    deliverTo?: Harness
    fast?: boolean
  } = {}
): World {
  const hrefs: string[] = []
  const urls: string[] = []
  const origin = o.origin ?? PAGE_ORIGIN
  const http = createInMemoryHttp({ origin })
  const disposers: (() => void)[] = []
  const win: LoopbackWindow = {
    location: {
      origin,
      get href() {
        return hrefs[hrefs.length - 1] ?? `${origin}/`
      },
      set href(v: string) {
        hrefs.push(v)
        o.deliverTo?.native.emitLaunch(plainUriOfIntent(v))
      }
    },
    crypto: globalThis.crypto as LoopbackWindow['crypto'],
    ...(o.permissions ? { navigator: { permissions: { query: ({ name }) => o.permissions!(name) } } } : {})
  }
  const tokenStore = memoryTokenStore()
  const opts: LoopbackOptions = {
    scheme: SCHEME,
    packageId: 'org.bsvblockchain.wallet',
    fetch: (url, init) => {
      urls.push(url)
      return http.fetch(url, init)
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: t => clearTimeout(t),
    tokenStore,
    ...(o.fast
      ? { attemptTimeoutMs: 40, roundMs: 5, totalMs: 120, window: 4 }
      : { attemptTimeoutMs: 400, roundMs: 10, totalMs: 3000 })
  }
  return {
    win,
    http,
    urls,
    hrefs,
    tokenStore,
    opts,
    client: over => createLoopbackPageClient(win, { ...opts, ...over }),
    mountWallet(h, port) {
      h.native.startServerResult = { port, ipv4: true, ipv6: true }
      const m = fromFakeNative(h.native)
      http.mount(`127.0.0.1:${port}`, m.handler)
      disposers.push(m.dispose)
      return m
    },
    dispose() {
      for (const d of disposers.splice(0)) d()
    }
  }
}

export const corsFor = (origin: string): [string, string][] => [
  ['Access-Control-Allow-Origin', origin],
  ['Access-Control-Expose-Headers', 'BRC-185-Android-Ack'],
  ['Cache-Control', 'no-store'],
  ['Vary', 'Origin']
]

export interface Squatter {
  handler: MemoryHandler
  identity: ContinuityHandle
  /** Every request received, serialised whole (method, url, headers, body). */
  seen: string[]
  requests: MemoryRequest[]
}

/**
 * A fake wallet on a port the real one does not hold: a valid, signed descriptor under its own key with the real name
 * and vendor, CORS correct, and no `k`, so never a describe acknowledgement. `hang` models one that never answers.
 */
export async function createSquatter(host: string, o: { hang?: boolean; origin?: string } = {}): Promise<Squatter> {
  const origin = o.origin ?? PAGE_ORIGIN
  const identity = await createSecureStoreContinuity({ secureStore: memorySecureStore() }).getOrCreate(
    `android:${origin}`
  )
  const seen: string[] = []
  const requests: MemoryRequest[] = []
  const handler: MemoryHandler = async req => {
    seen.push(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: req.body }))
    requests.push(req)
    if (o.hang) return new Promise(() => {})
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/.well-known/brc-wallet') {
      const challenge = url.searchParams.get('challenge')!
      const descriptor: Descriptor = {
        version: 1,
        instanceId: identity.instanceId,
        name: 'Test Wallet',
        instanceLabel: 'Test Wallet',
        vendor: 'org.test',
        continuityKey: identity.continuityKey,
        endpoints: [{ id: 'json-ipv4', type: 'http-json', address: `http://${host}` }]
      }
      const signed = await signDescribe(identity, { origin, challenge, descriptor })
      return {
        status: 200,
        headers: [...corsFor(origin), ['Content-Type', 'application/json']],
        body: JSON.stringify(signed)
      }
    }
    return { status: 404, headers: corsFor(origin), body: '' }
  }
  return { handler, identity, seen, requests }
}

/** Forwards every request to `target`, rewriting `Host` to what the target expects (a relay that works at all). */
export function createRelay(target: MemoryHandler, targetHost: string, o: { rewriteHost?: boolean } = {}) {
  const seen: MemoryRequest[] = []
  const handler: MemoryHandler = req => {
    seen.push(req)
    return target({
      ...req,
      headers: { ...req.headers, host: o.rewriteHost === false ? req.headers.host : targetHost }
    })
  }
  return { handler, seen }
}

export const bytesToB64u = b64uEncode
