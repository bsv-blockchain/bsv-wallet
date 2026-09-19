import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  buildProfileCertificate,
  type ProfileCertJson,
  type ProfileSigner
} from '../../../core/identity/handleRegistry/profileCert'
import { createHandleRegistryClient } from '../../../core/identity/handleRegistry/client'
import type { RegistryEndpoints, RegistryResolver } from '../../../core/identity/handleRegistry/resolver'

const PIN = { domain: 'deggen.com', url: 'https://registry.example' }
const KEY = PrivateKey.fromRandom()
const SIGNER = new ProtoWallet(KEY) as unknown as ProfileSigner

let cert: ProfileCertJson
/** Somebody else the server's prefix search will volunteer alongside `cert`. */
let neighbour: ProfileCertJson
/** The same neighbour, registered on the foreign domain: the only row that can
 * tell the foreign exact-match rule apart from the domain check. */
let foreignNeighbour: ProfileCertJson
beforeAll(async () => {
  cert = await buildProfileCertificate({
    signer: SIGNER,
    paymail: `dee@${PIN.domain}`,
    issuedAt: new Date('2026-09-18T10:00:00.000Z'),
    displayName: 'Dee K'
  })
  neighbour = await buildProfileCertificate({
    signer: new ProtoWallet(PrivateKey.fromRandom()) as unknown as ProfileSigner,
    paymail: `dee2@${PIN.domain}`,
    issuedAt: new Date('2026-09-18T10:00:00.000Z')
  })
  foreignNeighbour = await buildProfileCertificate({
    signer: new ProtoWallet(PrivateKey.fromRandom()) as unknown as ProfileSigner,
    paymail: 'dee2@other.example',
    issuedAt: new Date('2026-09-18T10:00:00.000Z')
  })
})
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  jest.restoreAllMocks()
})

/** `unreadable` is what an HTML error page from a proxy does: `json()` rejects
 * rather than resolving to undefined. */
type Reply = { status: number; body?: unknown; date?: string; unreadable?: boolean }
function transport(reply: (url: string, init?: RequestInit) => Reply | Promise<Reply>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = await reply(String(url), init)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'date' ? (r.date ?? null) : null) },
      json: async () => {
        if (r.unreadable === true) throw new SyntaxError('Unexpected token < in JSON at position 0')
        return r.body
      }
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** A resolver that answers for one foreign domain and nothing else. */
function resolverFor(domain: string, origin: string | null): RegistryResolver {
  return {
    async resolve(asked) {
      if (asked === PIN.domain) {
        return {
          domain: PIN.domain,
          search: q => `${PIN.url}/api/handle/${encodeURIComponent(q)}`,
          reverse: k => `${PIN.url}/api/identityKey/${encodeURIComponent(k)}`,
          pinned: true
        } as RegistryEndpoints
      }
      if (asked !== domain || origin === null) return null
      return {
        domain,
        search: q => `${origin}/api/handle/${encodeURIComponent(q)}`,
        reverse: k => `${origin}/api/identityKey/${encodeURIComponent(k)}`,
        pinned: false
      } as RegistryEndpoints
    },
    clearCache() {}
  }
}

describe('the pinned configuration', () => {
  it('normalises the domain it reports and the origin every URL is built from', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: { available: true } }))
    const client = createHandleRegistryClient({
      pinned: { domain: ' Deggen.COM ', url: 'https://registry.example/' },
      fetchImpl
    })
    // Consumed verbatim downstream: Profile renders the fixed `@<domain>` suffix
    // and compares a cached full paymail against it, and every URL here is
    // string concatenation — a stray trailing slash would give `//api/handle`.
    expect(client.domain).toBe('deggen.com')
    expect(await client.checkAvailability('dee')).toEqual({ kind: 'available' })
    expect(calls[0].url).toBe('https://registry.example/api/handle/available/dee')
  })
})

describe('checkAvailability', () => {
  it('refuses a malformed handle locally, with no request at all', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: { available: true } }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl })
    expect(await client.checkAvailability('x')).toEqual({ kind: 'unavailable', reason: 'invalid' })
    expect(calls).toEqual([])
  })

  it('asks the pinned registry and reports available', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: { available: true } }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl })
    expect(await client.checkAvailability('Dee')).toEqual({ kind: 'available' })
    expect(calls[0].url).toBe('https://registry.example/api/handle/available/dee')
  })

  it.each([
    ['taken', 'taken'],
    ['too_similar', 'too_similar'],
    ['reserved', 'reserved'],
    ['invalid', 'invalid'],
    ['cooldown', 'cooldown'],
    // A released row whose issuedAt has not passed yet is, to the person
    // typing, the same fact as a cooldown: not claimable right now.
    ['stale', 'cooldown']
  ])('maps the server reason %s to %s', async (server, mapped) => {
    const { fetchImpl } = transport(() => ({ status: 200, body: { available: false, reason: server } }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl })
    expect(await client.checkAvailability('dee')).toEqual({ kind: 'unavailable', reason: mapped })
  })

  it('reports failed for an unknown reason, an error status or a dead transport', async () => {
    const unknown = transport(() => ({ status: 200, body: { available: false, reason: 'martian' } }))
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: unknown.fetchImpl }).checkAvailability('dee')
    ).toEqual({ kind: 'failed' })
    const server = transport(() => ({ status: 503 }))
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: server.fetchImpl }).checkAvailability('dee')
    ).toEqual({ kind: 'failed' })
    const dead = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl: dead }).checkAvailability('dee')).toEqual({
      kind: 'failed'
    })
  })
})

describe('putCertificate', () => {
  it('PUTs the certificate JSON to the pinned registry', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 201 }))
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl }).putCertificate(cert)).toEqual({
      kind: 'created'
    })
    expect(calls[0].url).toBe('https://registry.example/api/handle')
    expect(calls[0].init?.method).toBe('PUT')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(cert)
  })

  it('reads 200 as an applied write — an update, a release, or a replay', async () => {
    const { fetchImpl } = transport(() => ({ status: 200 }))
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl }).putCertificate(cert)).toEqual({ kind: 'ok' })
  })

  it.each([400, 404, 409, 413])('reads %d as the server answering "no"', async status => {
    const { fetchImpl } = transport(() => ({
      status,
      body: { status: 'error', code: 'ERR_HANDLE_TAKEN', description: 'That handle belongs to another identity key.' }
    }))
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl }).putCertificate(cert)).toEqual({
      kind: 'rejected',
      code: 'ERR_HANDLE_TAKEN',
      description: 'That handle belongs to another identity key.'
    })
  })

  it('names the status when the error body is missing or unreadable', async () => {
    const named = { kind: 'rejected', code: 'ERR_HTTP_400', description: 'registry HTTP 400' }
    const { fetchImpl } = transport(() => ({ status: 400, body: undefined }))
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl }).putCertificate(cert)).toEqual(named)
    // What a real 400 from a proxy looks like: an HTML page, so `json()` rejects.
    const unreadable = transport(() => ({ status: 400, unreadable: true }))
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: unreadable.fetchImpl }).putCertificate(cert)
    ).toEqual(named)
  })

  it.each([429, 500, 502])('reads %d as a transport failure, not a refusal', async status => {
    const { fetchImpl } = transport(() => ({ status }))
    const result = await createHandleRegistryClient({ pinned: PIN, fetchImpl }).putCertificate(cert)
    expect(result.kind).toBe('failed')
  })

  it('reads a thrown request as a failure carrying its message', async () => {
    const dead = (async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl: dead }).putCertificate(cert)).toEqual({
      kind: 'failed',
      message: 'socket hang up'
    })
  })
})

describe('search', () => {
  it('asks the pinned registry for a bare query and returns only verified rows', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: [cert, { junk: true }] }))
    const rows = await createHandleRegistryClient({ pinned: PIN, fetchImpl }).search('dee')
    expect(calls[0].url).toBe('https://registry.example/api/handle/dee')
    expect(rows).toHaveLength(1)
    expect(rows[0].paymail).toBe(`dee@${PIN.domain}`)
    expect(rows[0].displayName).toBe('Dee K')
  })

  it('sends the local part when a domain is being typed and it is a prefix of ours', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: [] }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl })
    await client.search('dee@deg')
    await client.search('dee@')
    expect(calls.map(c => c.url)).toEqual([
      'https://registry.example/api/handle/dee',
      'https://registry.example/api/handle/dee'
    ])
  })

  it('resolves a complete foreign domain and asks that registry instead', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: [] }))
    const client = createHandleRegistryClient({
      pinned: PIN,
      fetchImpl,
      resolver: resolverFor('other.example', 'https://mb.other.example')
    })
    expect(await client.search('dee@other.example')).toEqual([])
    expect(calls[0].url).toBe('https://mb.other.example/api/handle/dee')
  })

  it('drops a foreign row whose paymail is for a different domain than the one asked', async () => {
    const { fetchImpl } = transport(() => ({ status: 200, body: [cert] }))
    const client = createHandleRegistryClient({
      pinned: PIN,
      fetchImpl,
      resolver: resolverFor('other.example', 'https://mb.other.example')
    })
    expect(await client.search('dee@other.example')).toEqual([])
  })

  it('makes no request at all for a query it cannot route', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: [] }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl })
    expect(await client.search('d')).toEqual([])
    expect(await client.search('')).toEqual([])
    expect(await client.search('dee@not a domain')).toEqual([])
    // The server's own gate, restated: over 32 characters, outside
    // [a-z0-9._-], or a path its route table claims for something else.
    expect(await client.search('a'.repeat(33))).toEqual([])
    expect(await client.search('dée')).toEqual([])
    expect(await client.search('available')).toEqual([])
    // The same gate on the local part of an `@` query, which is the dangerous
    // half: `/api/handle/available` is mounted ahead of the search route and
    // answers 400 ERR_INVALID_LOOKUP, so an ungated `available@deggen.com`
    // would raise the outage banner off an ordinary typed word.
    expect(await client.search(`available@${PIN.domain}`)).toEqual([])
    expect(await client.search(`d@${PIN.domain}`)).toEqual([])
    expect(calls).toEqual([])
  })

  it('reads an answer that is not an array as no results, rather than as an outage', async () => {
    // A misconfigured proxy in front of the well-known template serving an
    // error envelope with status 200. `search` throws on failure, so a
    // TypeError out of `body.map` would land as the outage banner.
    const { fetchImpl } = transport(() => ({ status: 200, body: { status: 'error', code: 'ERR_INVALID_LOOKUP' } }))
    await expect(createHandleRegistryClient({ pinned: PIN, fetchImpl }).search('dee')).resolves.toEqual([])
  })

  /**
   * Trust model §3: a complete `handle@domain` is a statement about one person,
   * so only that exact row may come back. The server's search is a prefix,
   * skeleton and substring search, so it happily volunteers neighbours.
   */
  it('returns only the exact row when the user typed a complete paymail', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: [neighbour, cert] }))
    const rows = await createHandleRegistryClient({ pinned: PIN, fetchImpl }).search(`dee@${PIN.domain}`)
    expect(calls[0].url).toBe('https://registry.example/api/handle/dee')
    expect(rows.map(r => r.paymail)).toEqual([`dee@${PIN.domain}`])
  })

  it('answers nothing at all when the complete paymail the user typed is not among the rows', async () => {
    const { fetchImpl } = transport(() => ({ status: 200, body: [cert, neighbour] }))
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl }).search(`deeb@${PIN.domain}`)).toEqual([])
  })

  /**
   * The one place "the user typed a complete address" and "only the exact row
   * survives" come apart, and it is deliberate: no registered handle is two
   * characters (the server's own rule is 3-32), so `de@deggen.com` can name
   * nobody. Read strictly it would answer nothing at all; read as a fragment —
   * which is what it is — the prefix neighbours are still offered as
   * suggestions, and each row carries its own full `handle@domain`.
   */
  it('reads a complete domain with a local part too short to be a handle as a fragment', async () => {
    const pinned = transport(() => ({ status: 200, body: [cert, neighbour] }))
    const rows = await createHandleRegistryClient({ pinned: PIN, fetchImpl: pinned.fetchImpl }).search(
      `de@${PIN.domain}`
    )
    expect(rows.map(r => r.paymail)).toEqual([`dee@${PIN.domain}`, `dee2@${PIN.domain}`])
    const foreign = transport(() => ({ status: 200, body: [foreignNeighbour] }))
    const client = createHandleRegistryClient({
      pinned: PIN,
      fetchImpl: foreign.fetchImpl,
      resolver: resolverFor('other.example', 'https://mb.other.example')
    })
    expect((await client.search('de@other.example')).map(r => r.paymail)).toEqual(['dee2@other.example'])
  })

  it('keeps every neighbour while the domain is still being typed', async () => {
    const { fetchImpl } = transport(() => ({ status: 200, body: [cert, neighbour] }))
    const rows = await createHandleRegistryClient({ pinned: PIN, fetchImpl }).search('dee@deg')
    expect(rows.map(r => r.paymail)).toEqual([`dee@${PIN.domain}`, `dee2@${PIN.domain}`])
  })

  /**
   * The same rule on the foreign branch of `routeFor`, proven by a row the
   * domain check alone cannot drop: `dee2@other.example` is for exactly the
   * domain that was asked, so only the typed paymail decides its fate.
   */
  it('applies the exact rule to a complete foreign paymail too', async () => {
    const client = (impl: typeof fetch) =>
      createHandleRegistryClient({
        pinned: PIN,
        fetchImpl: impl,
        resolver: resolverFor('other.example', 'https://mb.other.example')
      })
    const asked = transport(() => ({ status: 200, body: [foreignNeighbour] }))
    expect(await client(asked.fetchImpl).search('dee@other.example')).toEqual([])
    const named = transport(() => ({ status: 200, body: [foreignNeighbour] }))
    const rows = await client(named.fetchImpl).search('dee2@other.example')
    expect(rows.map(r => r.paymail)).toEqual(['dee2@other.example'])
  })

  it('throws on a transport failure, so Pay raises its existing banner', async () => {
    const dead = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    await expect(createHandleRegistryClient({ pinned: PIN, fetchImpl: dead }).search('dee')).rejects.toThrow('offline')
    const { fetchImpl } = transport(() => ({ status: 500 }))
    await expect(createHandleRegistryClient({ pinned: PIN, fetchImpl }).search('dee')).rejects.toThrow(/HTTP 500/)
  })

  it('throws when a foreign domain has no reachable registry', async () => {
    const { fetchImpl } = transport(() => ({ status: 200, body: [] }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl, resolver: resolverFor('other.example', null) })
    await expect(client.search('dee@other.example')).rejects.toThrow(/no registry for other.example/)
  })
})

describe('lookupIdentityKey', () => {
  it('verifies the answer against the key that was asked for', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 200, body: cert }))
    const profile = await createHandleRegistryClient({ pinned: PIN, fetchImpl }).lookupIdentityKey(cert.subject)
    expect(calls[0].url).toBe(`https://registry.example/api/identityKey/${cert.subject}`)
    expect(profile?.paymail).toBe(`dee@${PIN.domain}`)
  })

  it('answers null for a 404, a bad answer or a dead transport — never throwing', async () => {
    const missing = transport(() => ({ status: 404, body: { code: 'ERR_HANDLE_NOT_FOUND' } }))
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: missing.fetchImpl }).lookupIdentityKey(cert.subject)
    ).toBeNull()
    const wrongKey = transport(() => ({ status: 200, body: cert }))
    const other = PrivateKey.fromRandom().toPublicKey().toString()
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: wrongKey.fetchImpl }).lookupIdentityKey(other)
    ).toBeNull()
    const dead = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: dead }).lookupIdentityKey(cert.subject)
    ).toBeNull()
  })

  it('takes a domain, for a contact whose cached handle is somewhere else', async () => {
    const { fetchImpl, calls } = transport(() => ({ status: 404 }))
    const client = createHandleRegistryClient({
      pinned: PIN,
      fetchImpl,
      resolver: resolverFor('other.example', 'https://mb.other.example')
    })
    await client.lookupIdentityKey(cert.subject, 'other.example')
    expect(calls[0].url).toBe(`https://mb.other.example/api/identityKey/${cert.subject}`)
  })
})

/**
 * `lookupIdentityKey` flattens "there is none" and "there was no answer" into
 * one null, which is right for rendering and wrong for caching: a caller that
 * writes the answer into `contacts.cachedHandle` would blank a contact's handle
 * every time the device is offline. `lookupProfile` is the same request with
 * that distinction kept.
 */
describe('lookupProfile', () => {
  it('reports found with the verified profile', async () => {
    const { fetchImpl } = transport(() => ({ status: 200, body: cert }))
    const result = await createHandleRegistryClient({ pinned: PIN, fetchImpl }).lookupProfile(cert.subject)
    expect(result.kind).toBe('found')
    expect(result.kind === 'found' && result.profile.paymail).toBe(`dee@${PIN.domain}`)
  })

  it('reports none for a 404, and for an answer it cannot believe', async () => {
    const missing = transport(() => ({ status: 404, body: { code: 'ERR_HANDLE_NOT_FOUND' } }))
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: missing.fetchImpl }).lookupProfile(cert.subject)
    ).toEqual({ kind: 'none' })
    const wrongKey = transport(() => ({ status: 200, body: cert }))
    const other = PrivateKey.fromRandom().toPublicKey().toString()
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: wrongKey.fetchImpl }).lookupProfile(other)
    ).toEqual({ kind: 'none' })
  })

  it('reports failed for a dead transport, a server fault, or a domain with no registry', async () => {
    const dead = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await createHandleRegistryClient({ pinned: PIN, fetchImpl: dead }).lookupProfile(cert.subject)).toEqual({
      kind: 'failed'
    })
    const broken = transport(() => ({ status: 503 }))
    expect(
      await createHandleRegistryClient({ pinned: PIN, fetchImpl: broken.fetchImpl }).lookupProfile(cert.subject)
    ).toEqual({ kind: 'failed' })
    const unresolvable = transport(() => ({ status: 200, body: cert }))
    const client = createHandleRegistryClient({
      pinned: PIN,
      fetchImpl: unresolvable.fetchImpl,
      resolver: resolverFor('other.example', null)
    })
    expect(await client.lookupProfile(cert.subject, 'other.example')).toEqual({ kind: 'failed' })
  })
})

describe('serverNow', () => {
  it('is the device clock until a pinned response has been seen', () => {
    const { fetchImpl } = transport(() => ({ status: 200 }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl, now: () => 1_000_000 })
    expect(client.serverNow().getTime()).toBe(1_000_000)
  })

  it('corrects by the skew the pinned registry reported', async () => {
    const device = Date.parse('2026-09-18T10:00:00.000Z')
    const server = 'Fri, 18 Sep 2026 10:01:00 GMT'
    const { fetchImpl } = transport(() => ({ status: 200, body: { available: true }, date: server }))
    const client = createHandleRegistryClient({ pinned: PIN, fetchImpl, now: () => device })
    await client.checkAvailability('dee')
    expect(client.serverNow().toISOString()).toBe('2026-09-18T10:01:00.000Z')
  })

  it('takes no skew from a foreign registry', async () => {
    const device = Date.parse('2026-09-18T10:00:00.000Z')
    const { fetchImpl } = transport(() => ({ status: 200, body: [], date: 'Fri, 18 Sep 2026 23:00:00 GMT' }))
    const client = createHandleRegistryClient({
      pinned: PIN,
      fetchImpl,
      now: () => device,
      resolver: resolverFor('other.example', 'https://mb.other.example')
    })
    await client.search('dee@other.example')
    expect(client.serverNow().getTime()).toBe(device)
  })
})
