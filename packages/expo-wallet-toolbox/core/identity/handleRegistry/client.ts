/**
 * The registry's four routes.
 *
 * Two of the four have contracts inherited from the identity code they stand
 * in for, and they are opposites on purpose: `search` THROWS on a transport
 * failure, because Pay's error banner is raised from a catch and an empty
 * array would read as "nobody by that name"; `lookupIdentityKey` NEVER throws,
 * because an unknown peer and an unreachable registry get the same UI and a
 * profile lookup may never be the reason a screen fails to render.
 *
 * Writes only ever go to the pinned registry — a foreign domain is somewhere
 * to read from, never somewhere to publish to — and the clock skew that
 * `serverNow` corrects by is only ever taken from a pinned response, for the
 * same reason.
 */
import {
  MAX_SEARCH_RESULTS,
  SEARCH_MIN_QUERY_LENGTH,
  isRoutableSearchQuery,
  isValidHandleFormat,
  looksLikeDomain
} from './rules'
import { verifyProfileCertificate, type ProfileCertJson, type RegistryProfile } from './profileCert'
import { createRegistryResolver, fetchWithTimeout, type RegistryPin, type RegistryResolver } from './resolver'

/** Why a handle is not free. The server's `stale` arrives as `cooldown`. */
export type AvailabilityReason = 'taken' | 'too_similar' | 'reserved' | 'invalid' | 'cooldown'

export type AvailabilityResult =
  | { kind: 'available' }
  | { kind: 'unavailable'; reason: AvailabilityReason }
  | { kind: 'failed' }

/** `rejected` is the server answering no; `failed` is not having an answer. */
export type PutResult =
  | { kind: 'created' }
  | { kind: 'ok' }
  | { kind: 'rejected'; code: string; description: string }
  | { kind: 'failed'; message: string }

/**
 * `none` means the registry answered and holds nothing believable for that key;
 * `failed` means there was no answer at all. A caller that only renders can
 * flatten both to "no handle" — `lookupIdentityKey` does. A caller that WRITES
 * the answer into a cache cannot: blanking a contact's handle because the
 * device happened to be offline is the opposite of a cache.
 */
export type ProfileLookup = { kind: 'found'; profile: RegistryProfile } | { kind: 'none' } | { kind: 'failed' }

export interface HandleRegistryClient {
  /** The pinned domain: what a bare handle is registered under. */
  readonly domain: string
  checkAvailability(handle: string): Promise<AvailabilityResult>
  putCertificate(cert: ProfileCertJson): Promise<PutResult>
  /** Throws on transport failure — the contract `searchIdentities` already has. */
  search(query: string): Promise<RegistryProfile[]>
  /** Never throws. The full verdict, for callers that cache the answer. */
  lookupProfile(identityKey: string, domain?: string): Promise<ProfileLookup>
  /** Never throws — the contract `resolveIdentity` already has. */
  lookupIdentityKey(identityKey: string, domain?: string): Promise<RegistryProfile | null>
  /** The device clock, corrected by the skew the pinned registry last reported. */
  serverNow(): Date
}

function reasonOf(raw: unknown): AvailabilityReason | null {
  switch (raw) {
    case 'taken':
    case 'too_similar':
    case 'reserved':
    case 'invalid':
    case 'cooldown':
      return raw
    // A released row whose stored issuedAt has not passed yet: a certificate
    // dated now cannot beat it, so to the person typing this is a cooldown.
    case 'stale':
      return 'cooldown'
    default:
      return null
  }
}

export function createHandleRegistryClient(args: {
  pinned: RegistryPin
  fetchImpl?: typeof fetch
  now?: () => number
  resolver?: RegistryResolver
}): HandleRegistryClient {
  const fetchImpl = args.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const now = args.now ?? (() => Date.now())
  const domain = args.pinned.domain.trim().toLowerCase()
  const origin = args.pinned.url.trim().replace(/\/+$/, '')
  const resolver = args.resolver ?? createRegistryResolver({ pinned: args.pinned, fetchImpl, now })
  let skewMs = 0

  /** Only ever from the registry we write to: a foreign host's clock is not
   * the one our `issuedAt` has to beat. */
  function notePinnedSkew(res: Response): void {
    const header = res.headers?.get?.('date')
    const at = header ? Date.parse(header) : NaN
    if (Number.isFinite(at)) skewMs = at - now()
  }

  async function errorBody(res: Response): Promise<{ code: string; description: string }> {
    try {
      const body = (await res.json()) as { code?: unknown; description?: unknown } | undefined
      return {
        code: typeof body?.code === 'string' ? body.code : `ERR_HTTP_${res.status}`,
        description: typeof body?.description === 'string' ? body.description : `registry HTTP ${res.status}`
      }
    } catch {
      return { code: `ERR_HTTP_${res.status}`, description: `registry HTTP ${res.status}` }
    }
  }

  /**
   * Which registry answers this query, what to send it, and whether the user
   * typed a complete address rather than a fragment.
   *
   * `paymail` is set only for a complete `handle@domain`. The trust model then
   * requires that only a row with exactly that paymail be offered — the
   * server's search is a prefix, skeleton and substring search, so without this
   * a typed `dee@deggen.com` would be answered with `dee2`, `deeanna` and a
   * look-alike, any of which the user might take for the person they named.
   *
   * Complete means the domain is finished AND the local part could be a handle.
   * That second half is a choice: `de@deggen.com` can name nobody, because no
   * registered handle is two characters, so it is read as the fragment it is
   * and the prefix neighbours are still offered as suggestions — the strict
   * reading would answer an address that cannot exist with nothing at all.
   *
   * `isRoutableSearchQuery` is the server's own gate restated: over 32
   * characters, outside `[a-z0-9._-]`, or a path its route table claims (the
   * literal `available`, which answers `400 ERR_INVALID_LOOKUP` and would
   * otherwise surface as an outage) costs no request at all.
   *
   * `transient` marks the one place those two readings overlap — see the
   * comment on the prefix branch.
   */
  function routeFor(raw: string): { domain: string; query: string; paymail?: string; transient?: boolean } | null {
    const text = raw.trim().toLowerCase()
    const at = text.indexOf('@')
    if (at < 0) return isRoutableSearchQuery(text) ? { domain, query: text } : null
    const local = text.slice(0, at)
    const typed = text.slice(at + 1)
    if (local.length < SEARCH_MIN_QUERY_LENGTH || !isRoutableSearchQuery(local)) return null
    // A domain still being typed is a prefix of ours: still our registry, and
    // still a fragment — the user has not finished naming anybody yet.
    //
    // A prefix that is ITSELF a complete domain is not that. `.co` is a prefix
    // of `.com`, so for essentially any pinned `x.com` a finished, real,
    // different registry would be answered by ours — with the exact-paymail
    // rule switched off, because the address would be read as a fragment. A
    // typed `alice@deggen.co` would come back as every `*@deggen.com`
    // neighbour, squatter included, and never as the person named.
    if (typed === domain || (domain.startsWith(typed) && !looksLikeDomain(typed))) {
      const complete = typed === domain && isValidHandleFormat(local)
      return { domain, query: local, ...(complete ? { paymail: `${local}@${domain}` } : {}) }
    }
    if (!looksLikeDomain(typed)) return null
    const complete = isValidHandleFormat(local)
    return {
      domain: typed,
      query: local,
      ...(complete ? { paymail: `${local}@${typed}` } : {}),
      // Every character of our own domain is typed through on the way to it, so
      // a prefix of ours that resolves nowhere is a half-typed address rather
      // than an outage to raise a banner about mid-keystroke.
      ...(domain.startsWith(typed) ? { transient: true } : {})
    }
  }

  /** A free function rather than a method: `lookupIdentityKey` delegates to it,
   * and a destructured `const { lookupIdentityKey } = client` must still work. */
  async function lookupProfile(identityKey: string, forDomain?: string): Promise<ProfileLookup> {
    const key = identityKey.trim().toLowerCase()
    const target = (forDomain ?? domain).trim().toLowerCase()
    try {
      const endpoints = await resolver.resolve(target)
      if (!endpoints) return { kind: 'failed' }
      const res = await fetchWithTimeout(fetchImpl, endpoints.reverse(key), {
        headers: { accept: 'application/json' }
      })
      if (endpoints.pinned) notePinnedSkew(res)
      // Only a 404 is the registry saying "this key holds nothing". Every other
      // refusal is the registry not having answered the question at all, and a
      // caller that caches the answer has to be able to tell those apart.
      if (res.status === 404) return { kind: 'none' }
      if (!res.ok) return { kind: 'failed' }
      const profile = await verifyProfileCertificate(await res.json(), { domain: target, identityKey: key })
      return profile ? { kind: 'found', profile } : { kind: 'none' }
    } catch {
      return { kind: 'failed' }
    }
  }

  return {
    domain,

    async checkAvailability(handle) {
      const wanted = handle.trim().toLowerCase()
      // Checked here first so a half-typed handle costs no request and gets an
      // answer on the keystroke rather than after the round trip.
      if (!isValidHandleFormat(wanted)) return { kind: 'unavailable', reason: 'invalid' }
      try {
        const res = await fetchWithTimeout(fetchImpl, `${origin}/api/handle/available/${encodeURIComponent(wanted)}`, {
          headers: { accept: 'application/json' }
        })
        notePinnedSkew(res)
        if (!res.ok) return { kind: 'failed' }
        const body = (await res.json()) as { available?: unknown; reason?: unknown } | undefined
        if (body?.available === true) return { kind: 'available' }
        const reason = reasonOf(body?.reason)
        return reason ? { kind: 'unavailable', reason } : { kind: 'failed' }
      } catch {
        return { kind: 'failed' }
      }
    },

    async putCertificate(cert) {
      let res: Response
      try {
        res = await fetchWithTimeout(fetchImpl, `${origin}/api/handle`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(cert)
        })
      } catch (e) {
        return { kind: 'failed', message: e instanceof Error ? e.message : String(e) }
      }
      notePinnedSkew(res)
      if (res.status === 201) return { kind: 'created' }
      if (res.status === 200) return { kind: 'ok' }
      // Rate limiting and a server fault are both "ask again later"; every
      // other status is the registry having read the certificate and refused.
      if (res.status === 429 || res.status >= 500) return { kind: 'failed', message: `registry HTTP ${res.status}` }
      const { code, description } = await errorBody(res)
      return { kind: 'rejected', code, description }
    },

    async search(query) {
      const route = routeFor(query)
      if (!route) return []
      const endpoints = await resolver.resolve(route.domain)
      if (!endpoints) {
        if (route.transient) return []
        throw new Error(`handleRegistry: no registry for ${route.domain}`)
      }
      const res = await fetchWithTimeout(fetchImpl, endpoints.search(route.query), {
        headers: { accept: 'application/json' }
      })
      if (endpoints.pinned) notePinnedSkew(res)
      if (!res.ok) throw new Error(`handleRegistry: search failed with HTTP ${res.status}`)
      const body = (await res.json()) as unknown
      if (!Array.isArray(body)) return []
      const verified = await Promise.all(
        // Capped before a single signature is checked. The route's contract is
        // ten rows and our own server enforces it, but a complete foreign
        // domain the user typed is answered by a host bound by nothing — and
        // each row is one ECDSA verification on the thread the recipient field
        // is drawn from, so an uncapped answer is a freeze, not a long list.
        //
        // `expect.paymail` is what enforces "a complete address names one
        // person": set, every other row the server volunteered is dropped.
        body.slice(0, MAX_SEARCH_RESULTS).map(row =>
          verifyProfileCertificate(row, {
            domain: route.domain,
            ...(route.paymail ? { paymail: route.paymail } : {})
          })
        )
      )
      return verified.filter((profile): profile is RegistryProfile => profile !== null)
    },

    lookupProfile,

    async lookupIdentityKey(identityKey, forDomain) {
      const result = await lookupProfile(identityKey, forDomain)
      return result.kind === 'found' ? result.profile : null
    },

    serverNow() {
      return new Date(now() + skewMs)
    }
  }
}
