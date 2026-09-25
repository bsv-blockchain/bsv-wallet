/**
 * Which host answers for a domain.
 *
 * Our own domain is pinned by configuration: the host was stated by the build,
 * so asking DNS about it would only add a way to be told something else. Every
 * other domain resolves the way Paymail does — DNSSEC-authenticated SRV, then
 * the well-known capability document — because a foreign domain is the one
 * place this feature trusts an answer it did not bring with it.
 *
 * The AD requirement has one exception, and it is not a loophole: an SRV whose
 * target IS the domain names no new host, so an unauthenticated answer moves
 * nothing that `https://<domain>` would not already have reached.
 */
import { BRFC_LOOKUP, BRFC_REVERSE_LOOKUP, looksLikeDomain } from './rules'
import { isPublicHttpsUrl } from '../../net/publicDestination'

/** The domain this build's own handles live under, and the host serving it. */
export interface RegistryPin {
  readonly domain: string
  readonly url: string
}

/** The two routes, already substituted and encoded. */
export interface RegistryEndpoints {
  readonly domain: string
  search(query: string): string
  reverse(pubkey: string): string
  /** True for the configured domain, which skipped discovery entirely. */
  readonly pinned: boolean
}

export interface RegistryResolver {
  resolve(domain: string): Promise<RegistryEndpoints | null>
  /** Test seam, and the way a "try again" control forgets a failed lookup. */
  clearCache(): void
}

export const REGISTRY_TIMEOUT_MS = 8000
export const RESOLVER_SUCCESS_TTL_MS = 10 * 60 * 1000
export const RESOLVER_FAILURE_TTL_MS = 60 * 1000
export const DOH_ENDPOINTS: readonly string[] = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']
/**
 * Comfortably over ten capped profile certificates (MAX_SEARCH_RESULTS *
 * MAX_CERT_BODY_BYTES, ~160 KiB) plus JSON overhead — nothing this feature
 * legitimately reads is anywhere near this large (XR-077 / SEC2-027).
 */
export const REGISTRY_MAX_BODY_BYTES = 256 * 1024

const SRV_TYPE = 33
const NOERROR = 0
const NXDOMAIN = 3

/**
 * Reads a body no bigger than `maxBytes`, in whatever way the runtime allows.
 * A declared `Content-Length` over the cap is refused before anything is
 * read; otherwise, when the runtime exposes the body as a stream, chunks are
 * counted as they arrive and the read is aborted the instant the running
 * total crosses the cap — an untrusted host cannot make this allocate more
 * than the cap regardless of what it claims or how it paces the bytes
 * (XR-077 / SEC2-027). `fallback` (the original, unbounded `response.json`)
 * is used only when the runtime gives no stream to count from at all, which
 * this feature's own test doubles do — a floor, not a firewall, on a runtime
 * where nothing better is available.
 */
async function readBoundedJson(res: Response, fallback: () => Promise<unknown>, url: string): Promise<unknown> {
  const declared = res.headers?.get?.('content-length')
  if (declared) {
    const n = Number(declared)
    if (Number.isFinite(n) && n > REGISTRY_MAX_BODY_BYTES) {
      throw new Error(`handleRegistry: ${url} declared ${n} bytes, over the ${REGISTRY_MAX_BODY_BYTES} byte limit`)
    }
  }
  const reader = (res as { body?: ReadableStream<Uint8Array> | null }).body?.getReader?.()
  if (!reader) return await fallback()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > REGISTRY_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error(`handleRegistry: ${url} exceeded the ${REGISTRY_MAX_BODY_BYTES} byte limit while streaming`)
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(merged))
}

/**
 * One attempt, bounded — headers AND body. There is no shared fetch helper in
 * this codebase — every call site hand-rolls this — so this feature's two
 * networking modules share exactly one copy of it rather than two.
 *
 * A caller's own signal is composed, not replaced: the deadline is ours to add,
 * but a screen that cancels on unmount must still cancel the request rather than
 * hold it to the full eight seconds. `core/backup/client.ts` links the two the
 * same way — and, for the same reason it does, the deadline outlives the
 * headers: every caller in this feature reads a JSON body, and a connection
 * that delivers headers and then stalls (a captive portal, a half-closed load
 * balancer, a mobile link that drops mid-body) leaves `json()` pending for
 * ever. `registration.ts` serialises every write behind one promise, so a
 * single stalled body would wedge every later write for the life of the
 * process, with no toast and no timeout.
 */
export async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const caller = init?.signal ?? null
  const onAbort = () => controller.abort(caller?.reason)
  if (caller?.aborted) onAbort()
  caller?.addEventListener('abort', onAbort)
  const release = () => caller?.removeEventListener('abort', onAbort)
  const startedAt = Date.now()
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal })
  } catch (e) {
    release()
    throw e
  } finally {
    clearTimeout(timer)
  }
  const readJson = typeof response.json === 'function' ? response.json.bind(response) : null
  const hasBody = !!(response as { body?: unknown }).body
  if (!readJson && !hasBody) {
    release()
    return response
  }
  const fallback = readJson ?? (() => Promise.reject(new Error(`handleRegistry: ${url} has no json() and no body`)))
  // Rebinding the reader rather than buffering the body here: what each caller
  // asks for is all that is ever allocated. The abort is what stops a real
  // stalled stream; the rejection is what stops a transport that ignores it.
  response.json = async () => {
    let bodyTimer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise((resolve, reject) => {
        bodyTimer = setTimeout(
          () => {
            controller.abort()
            reject(new Error(`handleRegistry: no body from ${url} after ${REGISTRY_TIMEOUT_MS}ms`))
          },
          Math.max(0, REGISTRY_TIMEOUT_MS - (Date.now() - startedAt))
        )
        void readBoundedJson(response, fallback, url).then(resolve, reject)
      })
    } finally {
      if (bodyTimer !== undefined) clearTimeout(bodyTimer)
      release()
    }
  }
  return response
}

interface SrvRecord {
  priority: number
  weight: number
  port: number
  target: string
}

interface DohAnswer {
  type?: number
  data?: string
}

interface DohResponse {
  Status?: number
  AD?: boolean
  Answer?: DohAnswer[]
}

function parseSrv(data: string): SrvRecord | null {
  const parts = data.trim().split(/\s+/)
  if (parts.length < 4) return null
  const priority = Number(parts[0])
  const weight = Number(parts[1])
  const port = Number(parts[2])
  const target = parts[3].replace(/\.$/, '').toLowerCase()
  if (!Number.isFinite(priority) || !Number.isFinite(weight) || target === '') return null
  // A port that cannot be dialled does not belong in a URL: `:70000`, `:-1` and
  // `:44.3` are each read by some parser as something other than a port.
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { priority, weight, port, target }
}

/**
 * A foreign domain's own `.well-known/bsvalias` document names WHERE its
 * search/reverse routes live — nothing binds that to the domain the request
 * was made about. Without a host-class check, a foreign domain (no DNSSEC
 * spoofing needed against anyone else — an attacker publishing this for their
 * own domain is enough) could advertise a capability template rooted at a
 * loopback or private address and have every later search/reverse request
 * this feature makes land there instead (XR-073 / SEC2-057, SEC2-076).
 */
function templateOf(value: unknown, placeholder: string): string | null {
  if (typeof value !== 'string' || !value.startsWith('https://')) return null
  if (!value.includes(placeholder)) return null
  return isPublicHttpsUrl(value) ? value : null
}

export function createRegistryResolver(args: {
  pinned?: RegistryPin
  fetchImpl?: typeof fetch
  now?: () => number
  dohEndpoints?: readonly string[]
}): RegistryResolver {
  const fetchImpl = args.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const now = args.now ?? (() => Date.now())
  const dohEndpoints = args.dohEndpoints ?? DOH_ENDPOINTS
  const pinnedDomain = args.pinned?.domain.trim().toLowerCase() ?? ''
  const pinnedOrigin = args.pinned?.url.trim().replace(/\/+$/, '') ?? ''
  const cache = new Map<string, { at: number; value: RegistryEndpoints | null }>()

  const pinnedEndpoints: RegistryEndpoints | null =
    pinnedDomain !== '' && pinnedOrigin !== ''
      ? {
          domain: pinnedDomain,
          search: query => `${pinnedOrigin}/api/handle/${encodeURIComponent(query)}`,
          reverse: pubkey => `${pinnedOrigin}/api/identityKey/${encodeURIComponent(pubkey)}`,
          pinned: true
        }
      : null

  /**
   * The SRV answer, or the Paymail fallback, or null when DNS said nothing usable.
   *
   * Only NOERROR and NXDOMAIN are answers. Any other status — SERVFAIL, which
   * is what a resolver returns for a DNSSEC-bogus zone under `do=1`, or REFUSED
   * — carries no Answer either, so treating it as "no SRV" would quietly turn a
   * DNSSEC failure into `https://<domain>`. It is a failure of that resolver
   * instead, and the next one gets the question.
   */
  async function lookupSrv(domain: string): Promise<{ target: string; port: number } | null> {
    const fallback = { target: domain, port: 443 }
    for (const endpoint of dohEndpoints) {
      let body: DohResponse
      try {
        const url = `${endpoint}?name=${encodeURIComponent(`_bsvalias._tcp.${domain}`)}&type=SRV&do=1`
        const res = await fetchWithTimeout(fetchImpl, url, { headers: { accept: 'application/dns-json' } })
        if (!res.ok) continue
        body = (await res.json()) as DohResponse
      } catch {
        continue
      }
      if (body.Status !== NOERROR && body.Status !== NXDOMAIN) continue
      const records = (body.Answer ?? [])
        .filter(answer => answer.type === SRV_TYPE && typeof answer.data === 'string')
        .map(answer => parseSrv(answer.data as string))
        .filter((record): record is SrvRecord => record !== null)
      if (body.Status === NXDOMAIN || records.length === 0) return fallback
      records.sort((a, b) => a.priority - b.priority || b.weight - a.weight)
      const best = records[0]
      if (body.AD !== true && best.target !== domain) return null
      return { target: best.target, port: best.port }
    }
    return null
  }

  async function discover(domain: string): Promise<RegistryEndpoints | null> {
    const host = await lookupSrv(domain)
    if (!host) return null
    const origin = `https://${host.target}${host.port === 443 ? '' : `:${host.port}`}`
    // An SRV target is ordinarily just a hostname, but nothing stops one from
    // being an IP literal, `localhost`, or a `.local` name — and DNSSEC only
    // authenticates that the domain's own zone said so, not that it is a
    // sensible destination (XR-073 / SEC2-057, SEC2-076).
    if (!isPublicHttpsUrl(`${origin}/`)) return null
    let capabilities: Record<string, unknown>
    try {
      const res = await fetchWithTimeout(fetchImpl, `${origin}/.well-known/bsvalias`, {
        headers: { accept: 'application/json' }
      })
      if (!res.ok) return null
      const body = (await res.json()) as { capabilities?: Record<string, unknown> }
      capabilities = body?.capabilities ?? {}
    } catch {
      return null
    }
    const searchTemplate = templateOf(capabilities[BRFC_LOOKUP], '{query}')
    const reverseTemplate = templateOf(capabilities[BRFC_REVERSE_LOOKUP], '{pubkey}')
    if (!searchTemplate || !reverseTemplate) return null
    return {
      domain,
      search: query => searchTemplate.replace('{query}', encodeURIComponent(query)),
      reverse: pubkey => reverseTemplate.replace('{pubkey}', encodeURIComponent(pubkey)),
      pinned: false
    }
  }

  return {
    async resolve(rawDomain) {
      const domain = rawDomain.trim().toLowerCase()
      if (pinnedEndpoints && domain === pinnedDomain) return pinnedEndpoints
      // Ahead of the cache, not inside discovery: a half-typed domain is not an
      // answer, and the cache has no eviction — search resolves as the user types.
      if (!looksLikeDomain(domain)) return null
      const hit = cache.get(domain)
      if (hit && now() - hit.at < (hit.value ? RESOLVER_SUCCESS_TTL_MS : RESOLVER_FAILURE_TTL_MS)) return hit.value
      const value = await discover(domain)
      cache.set(domain, { at: now(), value })
      return value
    },
    clearCache() {
      cache.clear()
    }
  }
}
