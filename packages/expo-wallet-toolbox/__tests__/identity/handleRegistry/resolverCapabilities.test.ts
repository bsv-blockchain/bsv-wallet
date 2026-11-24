import {
  RESOLVER_FAILURE_TTL_MS,
  RESOLVER_SUCCESS_TTL_MS,
  createRegistryResolver
} from '../../../core/identity/handleRegistry/resolver'
import { OTHER, notOk, ok, srv, transport, wellKnown } from '../../__helpers__/fakeTransport'

const PIN = { domain: 'deggen.com', url: 'https://messagebox.bsvblockchain.tech' }
const DOH = 'dns-query'
const P2P = '2a40af698840'
const SRV_OK = () => ok(srv('10 5 8443 mb.other.example.'))

describe('discoverCapabilities', () => {
  it('returns the raw map and the origin for a foreign domain', async () => {
    const doc = wellKnown({ [P2P]: 'https://mb.other.example/p2p/{alias}@{domain.tld}' })
    const { fetchImpl } = transport([
      [DOH, async () => SRV_OK()],
      ['.well-known/bsvalias', async () => ok(doc)]
    ])
    const r = createRegistryResolver({ fetchImpl })
    expect(await r.discoverCapabilities(OTHER)).toEqual({
      kind: 'ok',
      domain: OTHER,
      origin: 'https://mb.other.example:8443',
      capabilities: doc.capabilities
    })
  })

  it('returns ok for a legacy-only document, while resolve() stays null', async () => {
    const doc = {
      bsvalias: '1.0',
      capabilities: { [P2P]: 'https://h.other.example/p2p/{alias}@{domain.tld}' }
    }
    const { fetchImpl } = transport([
      [DOH, async () => SRV_OK()],
      ['.well-known/bsvalias', async () => ok(doc)]
    ])
    const r = createRegistryResolver({ fetchImpl })
    expect((await r.discoverCapabilities(OTHER)).kind).toBe('ok')
    expect(await r.resolve(OTHER)).toBeNull()
  })

  it('unsecured for an SRV without AD that points elsewhere', async () => {
    const { fetchImpl } = transport([[DOH, async () => ok(srv('10 5 443 mb.other.example.', { AD: false }))]])
    expect(await createRegistryResolver({ fetchImpl }).discoverCapabilities(OTHER)).toEqual({ kind: 'unsecured' })
  })

  it('unsecured for an SRV target that is a loopback literal', async () => {
    const { fetchImpl } = transport([[DOH, async () => ok(srv('10 5 443 127.0.0.1.'))]])
    expect(await createRegistryResolver({ fetchImpl }).discoverCapabilities(OTHER)).toEqual({ kind: 'unsecured' })
  })

  it.each([
    ['HTTP 404 on the well-known', () => notOk(404)],
    ['capabilities is a string', () => ok({ capabilities: 'x' })],
    ['capabilities is an array', () => ok({ capabilities: [] })],
    ['the document is not an object', () => ok('x')]
  ])('none for %s', async (_name, make) => {
    const { fetchImpl } = transport([
      [DOH, async () => SRV_OK()],
      ['.well-known/bsvalias', async () => make()]
    ])
    expect(await createRegistryResolver({ fetchImpl }).discoverCapabilities(OTHER)).toEqual({ kind: 'none' })
  })

  it('failed for HTTP 503 on the well-known', async () => {
    const { fetchImpl } = transport([
      [DOH, async () => SRV_OK()],
      ['.well-known/bsvalias', async () => notOk(503)]
    ])
    expect(await createRegistryResolver({ fetchImpl }).discoverCapabilities(OTHER)).toEqual({ kind: 'failed' })
  })

  it('failed when the well-known request throws', async () => {
    const { fetchImpl } = transport([
      [DOH, async () => SRV_OK()],
      [
        '.well-known/bsvalias',
        async () => {
          throw new Error('boom')
        }
      ]
    ])
    expect(await createRegistryResolver({ fetchImpl }).discoverCapabilities(OTHER)).toEqual({ kind: 'failed' })
  })

  it('failed when both resolvers are down', async () => {
    const { fetchImpl } = transport([[DOH, async () => notOk(500)]])
    expect(await createRegistryResolver({ fetchImpl }).discoverCapabilities(OTHER)).toEqual({ kind: 'failed' })
  })

  it('a private-address capability URL stays in the map but resolve() refuses it', async () => {
    const doc = wellKnown({ '0ace65da5987': 'https://127.0.0.1/api/handle/{query}' })
    const { fetchImpl } = transport([
      [DOH, async () => SRV_OK()],
      ['.well-known/bsvalias', async () => ok(doc)]
    ])
    const r = createRegistryResolver({ fetchImpl })
    expect((await r.discoverCapabilities(OTHER)).kind).toBe('ok')
    expect(await r.resolve(OTHER)).toBeNull()
  })

  it('pinned domain: no network, kind ok, map has the two lookup ids', async () => {
    const { fetchImpl, calls } = transport([])
    const r = createRegistryResolver({ pinned: PIN, fetchImpl })
    const found = await r.discoverCapabilities('DEGGEN.com')
    expect(calls).toEqual([])
    expect(found.kind).toBe('ok')
    if (found.kind !== 'ok') throw new Error('unreachable')
    expect(found.origin).toBe(PIN.url)
    expect(Object.keys(found.capabilities).sort()).toEqual(['0ace65da5987', '43dcf83ddc5f'])
  })

  it('caches ok for ten minutes and the other kinds for one minute', async () => {
    let t = 1_000
    const good = transport([
      [DOH, async () => SRV_OK()],
      ['.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    const r1 = createRegistryResolver({ fetchImpl: good.fetchImpl, now: () => t })
    await r1.discoverCapabilities(OTHER)
    t += RESOLVER_SUCCESS_TTL_MS - 1
    await r1.discoverCapabilities(OTHER)
    expect(good.calls).toHaveLength(2)
    t += 1
    await r1.discoverCapabilities(OTHER)
    expect(good.calls).toHaveLength(4)

    t = 1_000
    const bad = transport([[DOH, async () => notOk(500)]])
    const r2 = createRegistryResolver({ fetchImpl: bad.fetchImpl, now: () => t })
    await r2.discoverCapabilities(OTHER)
    const first = bad.calls.length
    t += RESOLVER_FAILURE_TTL_MS - 1
    await r2.discoverCapabilities(OTHER)
    expect(bad.calls).toHaveLength(first)
    t += 1
    await r2.discoverCapabilities(OTHER)
    expect(bad.calls.length).toBe(first * 2)
  })

  it('clearCache(domain) forgets only that domain; clearCache() forgets all', async () => {
    const { fetchImpl, calls } = transport([
      [DOH, async () => SRV_OK()],
      ['.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    const r = createRegistryResolver({ fetchImpl })
    await r.discoverCapabilities(OTHER)
    await r.discoverCapabilities('third.example')
    expect(calls).toHaveLength(4)
    r.clearCache('third.example')
    await r.discoverCapabilities(OTHER)
    expect(calls).toHaveLength(4)
    await r.discoverCapabilities('third.example')
    expect(calls).toHaveLength(6)
    r.clearCache()
    await r.discoverCapabilities(OTHER)
    expect(calls).toHaveLength(8)
  })

  it('resolve() and discoverCapabilities() share one discovery', async () => {
    const { fetchImpl, calls } = transport([
      [DOH, async () => SRV_OK()],
      ['.well-known/bsvalias', async () => ok(wellKnown())]
    ])
    const r = createRegistryResolver({ fetchImpl })
    await r.resolve(OTHER)
    await r.discoverCapabilities(OTHER)
    expect(calls.filter(c => c.includes(DOH))).toHaveLength(1)
    expect(calls.filter(c => c.includes('.well-known'))).toHaveLength(1)
  })
})
