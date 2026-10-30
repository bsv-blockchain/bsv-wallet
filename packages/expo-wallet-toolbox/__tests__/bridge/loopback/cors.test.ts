import { BASE_HEADERS, corsHeaders, preflightHeaders } from '../../../core/bridge/loopback/cors'

const names = (h: [string, string][]) => h.map(x => x[0].toLowerCase())
const get = (h: [string, string][], n: string) => h.find(x => x[0].toLowerCase() === n.toLowerCase())?.[1]

describe('loopback CORS', () => {
  it('cors never emits credentials, wildcard or null', () => {
    for (const kind of ['public', 'binding'] as const) {
      const h = corsHeaders({ origin: 'https://example.com', kind })
      expect(names(h)).not.toContain('access-control-allow-credentials')
      expect(get(h, 'access-control-allow-origin')).toBe('https://example.com')
    }
    for (const bad of ['*', 'null', '']) {
      expect(() => corsHeaders({ origin: bad, kind: 'public' })).toThrow()
      expect(() => preflightHeaders({ origin: bad })).toThrow()
    }
  })

  it('exposes only the header for its kind', () => {
    expect(get(corsHeaders({ origin: 'https://a.example', kind: 'public' }), 'access-control-expose-headers')).toBe(
      'BRC-185-Android-Ack'
    )
    expect(get(corsHeaders({ origin: 'https://a.example', kind: 'binding' }), 'access-control-expose-headers')).toBe(
      'BRC-185-Reconnect-Token'
    )
  })

  it('preflight intersects requested headers (unlisted header dropped)', () => {
    const h = preflightHeaders({
      origin: 'https://a.example',
      requestHeaders: 'content-type, X-Evil, brc-185-epoch,BRC-185-Android-Binding'
    })
    expect(get(h, 'access-control-allow-headers')).toBe('Content-Type, BRC-185-Epoch, BRC-185-Android-Binding')
    expect(get(h, 'access-control-allow-methods')).toBe('GET, POST, DELETE, OPTIONS')
  })

  it('preflight with no requested headers emits no allow-headers', () => {
    expect(get(preflightHeaders({ origin: 'https://a.example' }), 'access-control-allow-headers')).toBeUndefined()
  })

  it('preflight echoes private-network only when asked', () => {
    expect(names(preflightHeaders({ origin: 'https://a.example' }))).not.toContain(
      'access-control-allow-private-network'
    )
    expect(
      get(
        preflightHeaders({ origin: 'https://a.example', privateNetwork: true }),
        'access-control-allow-private-network'
      )
    ).toBe('true')
  })

  it('no max-age, no credentials, no-store', () => {
    const h = preflightHeaders({ origin: 'https://a.example', requestHeaders: 'content-type', privateNetwork: true })
    expect(names(h)).not.toContain('access-control-max-age')
    expect(names(h)).not.toContain('access-control-allow-credentials')
    expect(get(h, 'cache-control')).toBe('no-store')
    expect(get(h, 'vary')).toBe('Origin')
  })

  it('base headers', () => {
    expect(BASE_HEADERS).toEqual([
      ['Cache-Control', 'no-store'],
      ['Vary', 'Origin'],
      ['X-Content-Type-Options', 'nosniff']
    ])
  })
})
