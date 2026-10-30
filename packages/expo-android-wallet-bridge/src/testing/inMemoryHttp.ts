/**
 * A fake `fetch` for the stand-in page client (spec 6.16, 10): requests are dispatched by `host:port` to whatever is
 * mounted there (the real controller through `fromFakeNative`, a squatter, a relay), with the browser behaviours that
 * matter for the protocol kept honest:
 *
 * - an unmounted `host:port` is a network failure (`TypeError`), as for a closed loopback port;
 * - a cross-origin response is readable only when `Access-Control-Allow-Origin` is exactly the page origin, and only
 *   the safelisted headers plus those in `Access-Control-Expose-Headers` can be read (so a header the router forgot to
 *   expose is invisible to the client, as in Chrome);
 * - a request with a non-simple method or header is preceded by an `OPTIONS` preflight that must succeed;
 * - `signal` aborts the request.
 *
 * Test tooling only. It never logs.
 */
import type { LoopbackFetch, LoopbackFetchInit, LoopbackResponse } from './loopbackPageClient'
import type { FakeNative } from './fakeNative'

export interface MemoryRequest {
  method: string
  url: string
  /** `host:port` as the page wrote it in the URL. */
  host: string
  /** Path and query, as sent on the request line. */
  target: string
  /** Lowercased names. Includes `host` and `origin`, as a browser sends them. */
  headers: Record<string, string>
  body: string
  preflight: boolean
  signal?: AbortSignal
}

export interface MemoryResponse {
  status: number
  headers: [string, string][]
  body: string
}

export type MemoryHandler = (req: MemoryRequest) => Promise<MemoryResponse>

export interface InMemoryHttp {
  fetch: LoopbackFetch
  mount(hostPort: string, handler: MemoryHandler): void
  unmount(hostPort: string): void
  /** Every request that reached a mounted handler, preflights included, in order. */
  log: MemoryRequest[]
}

const SAFELISTED_RESPONSE = [
  'cache-control',
  'content-language',
  'content-length',
  'content-type',
  'expires',
  'last-modified',
  'pragma'
]
const SAFELISTED_REQUEST = ['accept', 'accept-language', 'content-language']
const SIMPLE_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']

function networkError(): Error {
  const e = new TypeError('Failed to fetch')
  return e
}

function abortError(): Error {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

function header(h: [string, string][], name: string): string | undefined {
  const lower = name.toLowerCase()
  const hit = h.find(([k]) => k.toLowerCase() === lower)
  return hit?.[1]
}

function needsPreflight(method: string, headers: Record<string, string>): string[] | undefined {
  const custom = Object.keys(headers).filter(k => {
    if (k === 'host' || k === 'origin') return false
    if (SAFELISTED_REQUEST.includes(k)) return false
    if (k === 'content-type') return !SIMPLE_CONTENT_TYPES.includes(headers[k].split(';')[0].trim().toLowerCase())
    return true
  })
  const simpleMethod = method === 'GET' || method === 'HEAD' || method === 'POST'
  if (simpleMethod && custom.length === 0) return undefined
  return custom.sort()
}

export function createInMemoryHttp(opts: { origin: string; cors?: boolean }): InMemoryHttp {
  const mounts = new Map<string, MemoryHandler>()
  const log: MemoryRequest[] = []
  const enforceCors = opts.cors !== false

  const call = (hostPort: string, req: MemoryRequest, signal?: AbortSignal): Promise<MemoryResponse> => {
    const handler = mounts.get(hostPort)
    if (!handler) return Promise.reject(networkError())
    if (signal?.aborted) return Promise.reject(abortError())
    log.push(req)
    return new Promise<MemoryResponse>((resolve, reject) => {
      const onAbort = () => reject(abortError())
      signal?.addEventListener('abort', onAbort, { once: true })
      handler(req).then(
        r => {
          signal?.removeEventListener('abort', onAbort)
          resolve(r)
        },
        e => {
          signal?.removeEventListener('abort', onAbort)
          reject(e)
        }
      )
    })
  }

  const fetch: LoopbackFetch = async (url: string, init: LoopbackFetchInit = {}): Promise<LoopbackResponse> => {
    const parsed = new URL(url)
    const hostPort = parsed.host
    const method = (init.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v
    headers.host = hostPort
    headers.origin = opts.origin
    const target = parsed.pathname + parsed.search
    const body = init.body ?? ''

    if (enforceCors) {
      const asked = needsPreflight(method, headers)
      if (asked !== undefined) {
        const preHeaders: Record<string, string> = {
          host: hostPort,
          origin: opts.origin,
          'access-control-request-method': method
        }
        if (asked.length > 0) preHeaders['access-control-request-headers'] = asked.join(',')
        const pre = await call(
          hostPort,
          {
            method: 'OPTIONS',
            url,
            host: hostPort,
            target,
            headers: preHeaders,
            body: '',
            preflight: true,
            signal: init.signal
          },
          init.signal
        )
        const okStatus = pre.status >= 200 && pre.status < 300
        const allowOrigin = header(pre.headers, 'access-control-allow-origin')
        const allowMethods = (header(pre.headers, 'access-control-allow-methods') ?? '')
          .split(',')
          .map(s => s.trim().toUpperCase())
        const allowHeaders = (header(pre.headers, 'access-control-allow-headers') ?? '')
          .split(',')
          .map(s => s.trim().toLowerCase())
        const methodOk = method === 'GET' || method === 'HEAD' || method === 'POST' || allowMethods.includes(method)
        if (!okStatus || allowOrigin !== opts.origin || !methodOk || !asked.every(h => allowHeaders.includes(h))) {
          throw networkError()
        }
      }
    }

    const res = await call(
      hostPort,
      { method, url, host: hostPort, target, headers, body, preflight: false, signal: init.signal },
      init.signal
    )

    let visible = res.headers
    if (enforceCors) {
      if (header(res.headers, 'access-control-allow-origin') !== opts.origin) throw networkError()
      const exposed = (header(res.headers, 'access-control-expose-headers') ?? '')
        .split(',')
        .map(s => s.trim().toLowerCase())
      visible = res.headers.filter(([k]) => {
        const lower = k.toLowerCase()
        return SAFELISTED_RESPONSE.includes(lower) || exposed.includes(lower)
      })
    }
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      headers: { get: (name: string) => header(visible, name) ?? null },
      text: async () => res.body
    }
  }

  return {
    fetch,
    mount: (hostPort, handler) => void mounts.set(hostPort, handler),
    unmount: hostPort => void mounts.delete(hostPort),
    log
  }
}

/**
 * Mounts a `FakeNative` as the Kotlin server: each request becomes `onRequest`, the response is what the controller
 * hands to `respond`. The page aborting before the answer is `onClientGone`. Wraps `native.respond` for the life of the
 * handler; call `dispose` to restore it.
 */
export function fromFakeNative(native: FakeNative): { handler: MemoryHandler; dispose(): void } {
  const waiting = new Map<string, (r: MemoryResponse) => void>()
  const original = native.respond.bind(native)
  const originalRespond = native.respond
  native.respond = async (id, status, headers, body) => {
    const delivered = await original(id, status, headers, body)
    const w = waiting.get(id)
    if (w && delivered) {
      waiting.delete(id)
      w({ status, headers, body })
    }
    return delivered
  }
  let seq = 0
  const handler: MemoryHandler = req =>
    new Promise<MemoryResponse>((resolve, reject) => {
      const id = `page-${++seq}`
      waiting.set(id, resolve)
      req.signal?.addEventListener(
        'abort',
        () => {
          if (waiting.delete(id)) {
            native.emitGone(id)
            reject(abortError())
          }
        },
        { once: true }
      )
      native.emitRequest({
        id,
        method: req.method,
        target: req.target,
        headers: Object.entries(req.headers) as [string, string][],
        body: req.body
      })
    })
  return {
    handler,
    dispose() {
      native.respond = originalRespond
      waiting.clear()
    }
  }
}
