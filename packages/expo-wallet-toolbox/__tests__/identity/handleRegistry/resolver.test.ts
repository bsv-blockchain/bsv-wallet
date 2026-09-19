import {
  DOH_ENDPOINTS,
  REGISTRY_TIMEOUT_MS,
  RESOLVER_FAILURE_TTL_MS,
  RESOLVER_SUCCESS_TTL_MS,
  createRegistryResolver,
  fetchWithTimeout
} from '../../../core/identity/handleRegistry/resolver'

const PIN = { domain: 'deggen.com', url: 'https://messagebox.bsvblockchain.tech' }
const OTHER = 'other.example'

const wellKnown = (over: Record<string, unknown> = {}) => ({
  bsvalias: '1.0',
  capabilities: {
    '0ace65da5987': 'https://mb.other.example/api/handle/{query}',
    '43dcf83ddc5f': 'https://mb.other.example/api/identityKey/{pubkey}',
    ...over
  }
})

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
/** The body matters for the refusals: a failing host may still answer with JSON. */
const notOk = (status: number, body: unknown = {}) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response

const srv = (data: string, over: Record<string, unknown> = {}) => ({
  Status: 0,
  AD: true,
  Answer: [{ name: `_bsvalias._tcp.${OTHER}`, type: 33, data }],
  ...over
})

/** One scripted transport: a list of [urlSubstring, response] rules. */
function transport(rules: [string, () => Promise<Response>][]) {
  const calls: string[] = []
  const inits: (RequestInit | undefined)[] = []
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    calls.push(String(input))
    inits.push(init)
    for (const [needle, make] of rules) if (String(input).includes(needle)) return await make()
    throw new Error(`unexpected request: ${String(input)}`)
  }) as unknown as typeof fetch
  return { fetchImpl, calls, inits }
}

describe('the pinned domain', () => {
  it('short-circuits: no DNS, no well-known, both routes built from the configured url', async () => {
    const { fetchImpl, calls } = transport([])
    const endpoints = await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve('DEGGEN.com')
    expect(calls).toEqual([])
    expect(endpoints?.pinned).toBe(true)
    expect(endpoints?.domain).toBe('deggen.com')
    expect(endpoints?.search('dee @x')).toBe('https://messagebox.bsvblockchain.tech/api/handle/dee%20%40x')
    expect(endpoints?.reverse('02ab')).toBe('https://messagebox.bsvblockchain.tech/api/identityKey/02ab')
  })
})

describe('a foreign domain', () => {
  it('takes the SRV target when the answer is DNSSEC-authenticated', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 8443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    const endpoints = await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)
    expect(calls[0]).toContain(`name=_bsvalias._tcp.${OTHER}`)
    expect(calls[0]).toContain('type=SRV')
    expect(calls[0]).toContain('do=1')
    expect(calls[1]).toBe('https://mb.other.example:8443/.well-known/bsvalias')
    expect(endpoints?.pinned).toBe(false)
    expect(endpoints?.search('dee')).toBe('https://mb.other.example/api/handle/dee')
    expect(endpoints?.reverse('02ab')).toBe('https://mb.other.example/api/identityKey/02ab')
    // The discovered template is the one that substitutes into a third party's URL.
    expect(endpoints?.search('dee @x')).toBe('https://mb.other.example/api/handle/dee%20%40x')
    expect(endpoints?.reverse('02ab/x')).toBe('https://mb.other.example/api/identityKey/02ab%2Fx')
  })

  it('asks each host in the dialect it answers — dns-json of the resolver, json of the registry', async () => {
    const { fetchImpl, inits } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)
    // Cloudflare's /dns-query answers wireformat without this header, which would
    // make the primary resolver dead weight: every lookup would wait out a failed
    // round trip before Google answered, and nothing would say so.
    expect(inits[0]?.headers).toEqual({ accept: 'application/dns-json' })
    expect(inits[1]?.headers).toEqual({ accept: 'application/json' })
  })

  it('omits the port from the well-known request when it is 443', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)
    expect(calls[1]).toBe('https://mb.other.example/.well-known/bsvalias')
  })

  it('prefers the lowest priority, then the highest weight', async () => {
    const { fetchImpl, calls } = transport([
      [
        'cloudflare-dns.com',
        async () =>
          ok({
            Status: 0,
            AD: true,
            Answer: [
              { type: 33, data: '20 100 443 low.other.example.' },
              { type: 33, data: '10 1 443 weak.other.example.' },
              { type: 33, data: '10 9 443 strong.other.example.' }
            ]
          })
      ],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)
    expect(calls[1]).toBe('https://strong.other.example/.well-known/bsvalias')
  })

  it('refuses an unauthenticated SRV that points somewhere else, without asking that host anything', async () => {
    // The well-known is served on purpose: null has to come from the AD rule, not
    // from a transport that had no rule for the host the resolver was about to
    // trust. The call count is the assertion — the attacker's host is never dialled.
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 443 mb.other.example.', { AD: false }))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('accepts an unauthenticated SRV that points at the domain itself — it names no new host', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok(srv(`10 5 443 ${OTHER}.`, { AD: false }))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).not.toBeNull()
    // And the exception stays an exception: the only host the unauthenticated
    // answer got to name is the domain that was asked about.
    expect(calls[1]).toBe(`https://${OTHER}/.well-known/bsvalias`)
  })

  it('falls back to the domain on port 443 for NXDOMAIN', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok({ Status: 3 })],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)
    expect(calls[1]).toBe(`https://${OTHER}/.well-known/bsvalias`)
  })

  it('falls back the same way when the answer carries no SRV record', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok({ Status: 0, AD: true, Answer: [{ type: 5, data: 'cname.example.' }] })],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)
    expect(calls[1]).toBe(`https://${OTHER}/.well-known/bsvalias`)
  })

  it.each([
    ['a port above the range', '10 5 70000'],
    ['a negative port', '10 5 -1'],
    ['a fractional port', '10 5 44.3']
  ])('treats an SRV with %s as no SRV at all, rather than dialling it', async (_label, head) => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok(srv(`${head} mb.other.example.`))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)
    expect(calls[1]).toBe(`https://${OTHER}/.well-known/bsvalias`)
  })

  it('tries Google when Cloudflare is down', async () => {
    const { fetchImpl, calls } = transport([
      [
        'cloudflare-dns.com',
        async () => {
          throw new Error('network down')
        }
      ],
      ['dns.google', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).not.toBeNull()
    expect(calls[0]).toContain(DOH_ENDPOINTS[0])
    expect(calls[1]).toContain(DOH_ENDPOINTS[1])
  })

  it('tries Google when Cloudflare answers with an error status', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => notOk(500)],
      ['dns.google', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).not.toBeNull()
    expect(calls[2]).toBe('https://mb.other.example/.well-known/bsvalias')
  })

  it('reads no SRV out of a DoH error response, even a well-formed one', async () => {
    // Same rule one layer up, and it is the one a captive portal or proxy tests:
    // a 403 whose body names a host is not an answer from a resolver.
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => notOk(403, srv('10 5 443 evil.other.example.'))],
      ['dns.google', async () => ok({ Status: 3 })],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)
    expect(calls[2]).toBe(`https://${OTHER}/.well-known/bsvalias`)
  })

  it('tries Google for a DNS failure status too — SERVFAIL is not "no SRV"', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok({ Status: 2 })],
      ['dns.google', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).not.toBeNull()
    expect(calls[2]).toBe('https://mb.other.example/.well-known/bsvalias')
  })

  it('answers null when both resolvers are down', async () => {
    const { fetchImpl, calls } = transport([
      [
        'cloudflare-dns.com',
        async () => {
          throw new Error('down')
        }
      ],
      ['dns.google', async () => notOk(502)]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('answers null when both resolvers report a DNS failure, rather than trying the bare domain', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok({ Status: 2 })],
      ['dns.google', async () => ok({ Status: 2 })]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).toBeNull()
    expect(calls[0]).toContain(DOH_ENDPOINTS[0])
    expect(calls[1]).toContain(DOH_ENDPOINTS[1])
    expect(calls).toHaveLength(2)
  })

  it.each([
    ['a missing lookup capability', { '0ace65da5987': undefined }],
    ['a missing reverse capability', { '43dcf83ddc5f': undefined }],
    ['an http template', { '0ace65da5987': 'http://mb.other.example/api/handle/{query}' }],
    ['a template with no placeholder', { '0ace65da5987': 'https://mb.other.example/api/handle' }]
  ])('answers null for a well-known with %s', async (_label, over) => {
    const { fetchImpl } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown(over))]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).toBeNull()
  })

  it('answers null when the well-known host refuses, whatever its error body says', async () => {
    // The status gates the body, so the body here is a perfectly good capability
    // document: an error page that happens to parse as one is not a registry.
    const { fetchImpl } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => notOk(503, wellKnown())]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).toBeNull()
  })

  it('answers null when the well-known request fails outright', async () => {
    const { fetchImpl } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 443 mb.other.example.'))],
      [
        '/.well-known/bsvalias',
        async () => {
          throw new Error('reset')
        }
      ]
    ])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve(OTHER)).toBeNull()
  })

  it('answers null for something that is not a domain, without asking anyone', async () => {
    const { fetchImpl, calls } = transport([])
    expect(await createRegistryResolver({ pinned: PIN, fetchImpl }).resolve('not a domain')).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('caching', () => {
  // The tests below advance the clock by these constants, so without this the
  // window they describe is whatever the constants happen to say.
  it('keeps a success for ten minutes and a failure for one, the windows the spec fixes', () => {
    expect([RESOLVER_SUCCESS_TTL_MS, RESOLVER_FAILURE_TTL_MS]).toEqual([600_000, 60_000])
  })

  it('serves a success from cache for ten minutes, then asks again', async () => {
    let clock = 1_000_000
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    const resolver = createRegistryResolver({ pinned: PIN, fetchImpl, now: () => clock })
    await resolver.resolve(OTHER)
    await resolver.resolve(OTHER)
    expect(calls).toHaveLength(2)
    clock += RESOLVER_SUCCESS_TTL_MS
    await resolver.resolve(OTHER)
    expect(calls).toHaveLength(4)
  })

  it('remembers a failure for only a minute', async () => {
    let clock = 1_000_000
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => notOk(500)],
      ['dns.google', async () => notOk(500)]
    ])
    const resolver = createRegistryResolver({ pinned: PIN, fetchImpl, now: () => clock })
    await resolver.resolve(OTHER)
    await resolver.resolve(OTHER)
    expect(calls).toHaveLength(2)
    clock += RESOLVER_FAILURE_TTL_MS
    await resolver.resolve(OTHER)
    expect(calls).toHaveLength(4)
  })

  it('drops everything on clearCache', async () => {
    const { fetchImpl, calls } = transport([
      ['cloudflare-dns.com', async () => ok(srv('10 5 443 mb.other.example.'))],
      ['/.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    const resolver = createRegistryResolver({ pinned: PIN, fetchImpl })
    await resolver.resolve(OTHER)
    resolver.clearCache()
    await resolver.resolve(OTHER)
    expect(calls).toHaveLength(4)
  })
})

/** The helper Task 5's client shares, so its bound is pinned here rather than twice. */
describe('fetchWithTimeout', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  /** Records the init the helper handed the transport, whatever it then does. */
  function recorder(answer: (init?: RequestInit) => Promise<Response>) {
    const seen: { init?: RequestInit } = {}
    const fetchImpl = (async (_input: string, init?: RequestInit) => {
      seen.init = init
      return await answer(init)
    }) as unknown as typeof fetch
    return { fetchImpl, seen }
  }

  it('bounds every attempt at the eight seconds the spec fixes', () => {
    expect(REGISTRY_TIMEOUT_MS).toBe(8000)
  })

  it('passes the caller init through with an abort signal, and drops the timer once it answers', async () => {
    const { fetchImpl, seen } = recorder(async () => ok({}))
    await fetchWithTimeout(fetchImpl, 'https://host/x', { headers: { accept: 'application/json' } })
    expect(seen.init?.headers).toEqual({ accept: 'application/json' })
    expect(seen.init?.signal).toBeInstanceOf(AbortSignal)
    expect(seen.init?.signal?.aborted).toBe(false)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('drops the timer when the transport throws, too', async () => {
    const { fetchImpl, seen } = recorder(async () => {
      throw new Error('network down')
    })
    await expect(fetchWithTimeout(fetchImpl, 'https://host/x')).rejects.toThrow('network down')
    expect(seen.init?.signal?.aborted).toBe(false)
    expect(jest.getTimerCount()).toBe(0)
  })

  it("composes the caller's own signal rather than replacing it, so an outside cancel still cancels", async () => {
    const outside = new AbortController()
    const { fetchImpl, seen } = recorder(
      async init =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const pending = fetchWithTimeout(fetchImpl, 'https://host/x', { signal: outside.signal })
    const assertion = expect(pending).rejects.toThrow('aborted')
    outside.abort()
    await assertion
    expect(seen.init?.signal?.aborted).toBe(true)
    // And the deadline timer goes with it, rather than firing eight seconds later.
    expect(jest.getTimerCount()).toBe(0)
  })

  it('hands through a caller signal that was already aborted before the call', async () => {
    const outside = new AbortController()
    outside.abort()
    const { fetchImpl, seen } = recorder(async () => ok({}))
    await fetchWithTimeout(fetchImpl, 'https://host/x', { signal: outside.signal })
    expect(seen.init?.signal?.aborted).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('aborts a request that never answers, at eight seconds', async () => {
    const { fetchImpl, seen } = recorder(
      async init =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const pending = fetchWithTimeout(fetchImpl, 'https://host/x')
    const assertion = expect(pending).rejects.toThrow('aborted')
    await jest.advanceTimersByTimeAsync(REGISTRY_TIMEOUT_MS - 1)
    expect(seen.init?.signal?.aborted).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    await assertion
    expect(seen.init?.signal?.aborted).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  })
})
