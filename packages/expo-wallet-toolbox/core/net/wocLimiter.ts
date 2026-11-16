/**
 * One request pacer for every WhatsOnChain call in the app.
 *
 * WhatsOnChain answers more than 3 requests per second from one client with no
 * API key with HTTP 429. Before this module, each feature paced itself or not at
 * all: the Vault chain scan sent 3 history requests per index back to back, so
 * an empty gap of 20 indices was 60 requests with no pause, and a sweep,
 * a proof refresh or a broadcast at the same time added to the same quota.
 *
 * Every WhatsOnChain request now takes a slot from a lane before it is sent. A
 * lane is one API origin, for requests with no key. The slot is reserved
 * synchronously, before any await, so callers that start at the same moment
 * queue behind each other instead of passing together. The first request on an
 * idle lane goes at once.
 *
 * A request that carries a `woc-api-key` header uses a lane of its own: it
 * counts against the key's quota, not the anonymous one. That lane has the same
 * spacing by default, because the tier of a key is not known here; a host with
 * a paid key can lower `keyedIntervalMs`. A 429 on any lane pushes that lane's
 * next slot out by `pauseMs`.
 */

/** Spacing of requests with no key: 2.5 per second, under the limit of 3 with room for network jitter. */
export const WOC_ANON_INTERVAL_MS = 400
/** Extra pause on a lane after WhatsOnChain answers 429. */
export const WOC_RATE_LIMIT_PAUSE_MS = 1500
/** The header WhatsOnChain reads an API key from. */
export const WOC_KEY_HEADER = 'woc-api-key'

export interface WocLimiterOptions {
  /** Spacing of requests with no key. */
  intervalMs: number
  /** Spacing of requests with a key. */
  keyedIntervalMs: number
  /** Extra pause after a 429. */
  pauseMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const defaults = (): WocLimiterOptions => ({
  intervalMs: WOC_ANON_INTERVAL_MS,
  keyedIntervalMs: WOC_ANON_INTERVAL_MS,
  pauseMs: WOC_RATE_LIMIT_PAUSE_MS,
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
})

let options: WocLimiterOptions = defaults()
/** Lane name to the earliest time its next request may go. */
const nextSlot = new Map<string, number>()

/** Change the limiter's spacing or clock (tests, or a host with a paid key). Clears every lane. */
export function configureWocLimiter(over: Partial<WocLimiterOptions>): void {
  options = { ...options, ...over }
  nextSlot.clear()
}

/** Back to the default spacing and clock, with every lane idle. */
export function resetWocLimiter(): void {
  options = defaults()
  nextSlot.clear()
}

function originOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i.exec(url)
  return match ? match[0].toLowerCase() : url
}

function hasKey(headers: HeadersInit | undefined): boolean {
  if (!headers) return false
  if (Array.isArray(headers)) return headers.some(([name, value]) => name.toLowerCase() === WOC_KEY_HEADER && !!value)
  if (typeof (headers as Headers).get === 'function') return !!(headers as Headers).get(WOC_KEY_HEADER)
  return Object.entries(headers as Record<string, string>).some(
    ([name, value]) => name.toLowerCase() === WOC_KEY_HEADER && !!value
  )
}

function laneFor(url: string, keyed: boolean): string {
  return `${originOf(url)}|${keyed ? 'key' : 'anon'}`
}

/**
 * Reserve this request's slot and return how long to wait for it (0 on an
 * idle lane). The reservation is synchronous, so the order of calls is the
 * order of requests.
 */
export function reserveWocSlot(url: string, keyed = false): number {
  const lane = laneFor(url, keyed)
  const now = options.now()
  const at = Math.max(now, nextSlot.get(lane) ?? 0)
  nextSlot.set(lane, at + (keyed ? options.keyedIntervalMs : options.intervalMs))
  return at - now
}

/** Wait the time that `reserveWocSlot` returned. Resolves at once for 0. */
export function waitWocSlot(ms: number): Promise<void> {
  return ms > 0 ? options.sleep(ms) : Promise.resolve()
}

/** Reserve this request's slot and wait for it. */
export function wocSlot(url: string, keyed = false): Promise<void> {
  return waitWocSlot(reserveWocSlot(url, keyed))
}

/** Record a 429 on a lane: its next slot moves out by `pauseMs`. */
export function wocRateLimited(url: string, keyed = false): void {
  const lane = laneFor(url, keyed)
  const until = options.now() + options.pauseMs
  nextSlot.set(lane, Math.max(nextSlot.get(lane) ?? 0, until))
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * `fetch` for WhatsOnChain, paced by the shared limiter. A GET or HEAD that
 * gets 429 is sent once more, after the lane's pause; the second answer is
 * returned as it is, so a caller still sees a 429 that lasts.
 */
export async function wocLimitedFetch(url: string, init?: RequestInit, fetchImpl?: FetchLike): Promise<Response> {
  const doFetch: FetchLike = fetchImpl ?? ((u, i) => (i ? fetch(u, i) : fetch(u)))
  const keyed = hasKey(init?.headers)
  const method = (init?.method ?? 'GET').toUpperCase()
  const retryable = method === 'GET' || method === 'HEAD'
  for (let attempt = 0; ; attempt++) {
    const wait = reserveWocSlot(url, keyed)
    if (wait > 0) await waitWocSlot(wait)
    const response = await doFetch(url, init)
    if (response.status !== 429) return response
    wocRateLimited(url, keyed)
    if (!retryable || attempt >= 1) return response
  }
}
