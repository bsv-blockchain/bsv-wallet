import { b64uEncode } from '../../../core/bridge/protocol/base64url'
import { assertAdvertisesResponder, verifyDescribeProof } from '../../../core/bridge/protocol/descriptor'
import { describeAck, helloMac } from '../../../core/bridge/loopback/launchProof'
import {
  CHALLENGE,
  EPOCH,
  HELLO_KEY,
  HOST4,
  HOST6,
  HOSTL,
  NONCE,
  ORIGIN,
  PORT,
  describeTarget,
  done,
  headerOf,
  identityHandle,
  makeHarness
} from './helpers/routerHarness'

const hostHeaders = (host: string, origin = ORIGIN): [string, string][] => [
  ['host', host],
  ['origin', origin]
]

const hasCors = (r: { headers: [string, string][] }) =>
  r.headers.some(([k]) => k.toLowerCase().startsWith('access-control-'))

describe('loopback router gate', () => {
  it('legacy path /getVersion is 404 without CORS', async () => {
    const h = makeHarness()
    for (const target of ['/getVersion', '/', '/.well-known/brc-wallet/', '/brc185/v1/rpc/']) {
      const r = done(await h.handle({ target }))
      expect(r.status).toBe(404)
      expect(r.body).toBe('')
      expect(hasCors(r)).toBe(false)
      expect(headerOf(r, 'Cache-Control')).toBe('no-store')
    }
  })

  it('known path wrong verb is 405 with Allow', async () => {
    const h = makeHarness()
    const cases: [string, string, string][] = [
      ['POST', '/.well-known/brc-wallet?challenge=x', 'GET, OPTIONS'],
      ['GET', '/.well-known/brc-wallet/connect', 'POST, OPTIONS'],
      ['GET', `/.well-known/brc-wallet/connect/${EPOCH}`, 'DELETE, OPTIONS'],
      ['PUT', '/brc185/v1/rpc/getVersion', 'POST, OPTIONS']
    ]
    for (const [method, target, allow] of cases) {
      const r = done(await h.handle({ method, target }))
      expect(r.status).toBe(405)
      expect(headerOf(r, 'Allow')).toBe(allow)
      expect(hasCors(r)).toBe(false)
    }
  })

  it('absolute-form, percent-encoded, dot-segment and non-canonical epoch targets are refused', async () => {
    const h = makeHarness()
    const targets = [
      `http://${HOST4}/.well-known/brc-wallet?challenge=${CHALLENGE}`,
      `/.well-known/brc%2dwallet?challenge=${CHALLENGE}`,
      `/.well-known/brc-wallet?challenge=%41${CHALLENGE.slice(1)}`,
      '/.well-known/../.well-known/brc-wallet',
      '/brc185/v1/rpc/./getVersion',
      '/brc185/v1/../v1/rpc/getVersion',
      `//.well-known/brc-wallet?challenge=${CHALLENGE}`,
      `/.well-known/brc-wallet/connect/${EPOCH.toUpperCase()}`,
      '/.well-known/brc-wallet/connect/not-an-epoch',
      `/.well-known/brc-wallet/connect/${EPOCH}/`,
      `/.well-known/brc-wallet/connect/${EPOCH}?x=1`,
      '/brc185/v1/rpc/get%56ersion',
      '/brc185/v1/rpc/get-version'
    ]
    for (const target of targets) {
      const method = target.includes('/rpc/') ? 'POST' : target.includes('/connect/') ? 'DELETE' : 'GET'
      const r = done(await h.handle({ method, target }))
      expect([404, 405]).toContain(r.status)
      expect(r.status).toBe(404)
      expect(r.body).toBe('')
      expect(hasCors(r)).toBe(false)
    }
    expect(h.calls).toEqual([])
  })

  it('missing, null, duplicate Origin is 403 empty without CORS', async () => {
    const h = makeHarness()
    const cases: [string, string][][] = [
      [['host', HOST4]],
      [
        ['host', HOST4],
        ['origin', 'null']
      ],
      [
        ['host', HOST4],
        ['origin', ORIGIN],
        ['origin', ORIGIN]
      ],
      [
        ['host', HOST4],
        ['origin', 'http://example.com']
      ],
      [
        ['host', HOST4],
        ['origin', 'https://example.com/path']
      ]
    ]
    for (const headers of cases) {
      const r = done(await h.handle({ target: describeTarget(), headers }))
      expect(r.status).toBe(403)
      expect(r.body).toBe('')
      expect(hasCors(r)).toBe(false)
    }
  })

  it('uppercase host and explicit default port origins are refused 403 without CORS', async () => {
    const h = makeHarness()
    for (const origin of ['https://Example.com', 'https://example.com:443', 'https://EXAMPLE.COM']) {
      const r = done(await h.handle({ target: describeTarget(), headers: hostHeaders(HOST4, origin) }))
      expect(r.status).toBe(403)
      expect(r.body).toBe('')
      expect(hasCors(r)).toBe(false)
    }
    expect(h.calls).toEqual([])
  })

  it('http://localhost:<port> is only accepted when the host allows it', async () => {
    const h = makeHarness()
    const o = 'http://localhost:3000'
    expect(done(await h.handle({ target: describeTarget(), headers: hostHeaders(HOST4, o) })).status).toBe(403)
    h.state.allowLocalhostHttp = true
    const r = done(await h.handle({ target: describeTarget(), headers: hostHeaders(HOST4, o) }))
    expect(r.status).toBe(200)
    expect(headerOf(r, 'Access-Control-Allow-Origin')).toBe(o)
  })

  it('the router re-checks Host against the bound set even though Kotlin did (wrong Host is 403 empty)', async () => {
    const h = makeHarness()
    const bad = [
      `127.0.0.1:${PORT + 1}`,
      'example.com',
      `LOCALHOST:${PORT}`,
      `localhost:${PORT}.`,
      `[::1]`,
      '10.0.2.2:3321'
    ]
    for (const host of bad) {
      const r = done(await h.handle({ target: describeTarget(), headers: hostHeaders(host) }))
      expect(r.status).toBe(403)
      expect(r.body).toBe('')
      expect(hasCors(r)).toBe(false)
    }
    // Missing and duplicate Host.
    expect(done(await h.handle({ target: describeTarget(), headers: [['origin', ORIGIN]] })).status).toBe(403)
    expect(
      done(
        await h.handle({
          target: describeTarget(),
          headers: [
            ['host', HOST4],
            ['host', HOST4],
            ['origin', ORIGIN]
          ]
        })
      ).status
    ).toBe(403)
    // localhost is only valid when both families are bound.
    h.state.bound = { port: PORT, ipv4: true, ipv6: false }
    expect(done(await h.handle({ target: describeTarget(), headers: hostHeaders(HOSTL) })).status).toBe(403)
    expect(done(await h.handle({ target: describeTarget(), headers: hostHeaders(HOST4) })).status).toBe(200)
  })

  it('Originator and BRC-185-Context headers are 400 PROTOCOL_ERROR', async () => {
    const h = makeHarness()
    for (const name of ['originator', 'brc-185-context']) {
      const r = done(
        await h.handle({ target: describeTarget(), headers: [...hostHeaders(HOST4), [name, 'https://evil.example']] })
      )
      expect(r.status).toBe(400)
      expect(JSON.parse(r.body)).toMatchObject({ domain: 'brc185', code: 'PROTOCOL_ERROR', delivery: 'not-sent' })
    }
  })

  it('OPTIONS preflight is 204, touches no state (registry, ledger, launches), carries CORS for an origin that passed step 2, and a refused origin gets 403 without CORS', async () => {
    const h = makeHarness()
    const targets = [
      describeTarget(),
      '/.well-known/brc-wallet/connect',
      `/.well-known/brc-wallet/connect/${EPOCH}`,
      '/brc185/v1/rpc/getVersion'
    ]
    for (const target of targets) {
      const r = done(
        await h.handle({
          method: 'OPTIONS',
          target,
          headers: [
            ...hostHeaders(HOST4),
            ['access-control-request-method', 'POST'],
            ['access-control-request-headers', 'content-type, brc-185-epoch, x-other'],
            ['access-control-request-private-network', 'true']
          ]
        })
      )
      expect(r.status).toBe(204)
      expect(r.body).toBe('')
      expect(headerOf(r, 'Access-Control-Allow-Origin')).toBe(ORIGIN)
      expect(headerOf(r, 'Access-Control-Allow-Methods')).toBe('GET, POST, DELETE, OPTIONS')
      expect(headerOf(r, 'Access-Control-Allow-Headers')).toBe('Content-Type, BRC-185-Epoch')
      expect(headerOf(r, 'Access-Control-Allow-Private-Network')).toBe('true')
      expect(headerOf(r, 'Access-Control-Max-Age')).toBeUndefined()
      expect(headerOf(r, 'Access-Control-Allow-Credentials')).toBeUndefined()
      expect(headerOf(r, 'Cache-Control')).toBe('no-store')
    }
    expect(h.calls).toEqual([])
    const refused = done(
      await h.handle({ method: 'OPTIONS', target: describeTarget(), headers: hostHeaders(HOST4, 'http://example.com') })
    )
    expect(refused.status).toBe(403)
    expect(hasCors(refused)).toBe(false)
  })
})

describe('loopback router describe', () => {
  it('noncanonical challenge is 400', async () => {
    const h = makeHarness()
    const bad = [
      '/.well-known/brc-wallet',
      '/.well-known/brc-wallet?challenge=',
      `/.well-known/brc-wallet?challenge=${CHALLENGE}=`,
      `/.well-known/brc-wallet?challenge=${CHALLENGE.slice(0, -1)}`,
      `/.well-known/brc-wallet?challenge=${CHALLENGE.slice(0, -1)}+`,
      `/.well-known/brc-wallet?challenge=${b64uEncode(new Uint8Array(31))}`,
      `/.well-known/brc-wallet?challenge=${CHALLENGE}&hello=short`
    ]
    for (const target of bad) {
      const r = done(await h.handle({ target }))
      expect(r.status).toBe(400)
      expect(JSON.parse(r.body).code).toBe('PROTOCOL_ERROR')
    }
  })

  it('unknown query parameter is 400', async () => {
    const h = makeHarness()
    for (const extra of ['&x=1', `&challenge=${CHALLENGE}`, '&hello=', '&']) {
      const r = done(await h.handle({ target: describeTarget(extra) }))
      expect(r.status).toBe(400)
    }
  })

  it('a describe request body over 16384 B is refused per the status table', async () => {
    const h = makeHarness()
    const ok = done(await h.handle({ target: describeTarget(), body: 'a'.repeat(16384) }))
    expect(ok.status).toBe(200)
    // 16385 bytes by UTF-8 length even though it is fewer characters.
    const r = done(await h.handle({ target: describeTarget(), body: 'é'.repeat(8193) }))
    expect(r.status).toBe(413)
    expect(JSON.parse(r.body)).toMatchObject({ code: 'RESOURCE_LIMIT', delivery: 'not-sent' })
    expect(headerOf(r, 'Access-Control-Allow-Origin')).toBe(ORIGIN)
  })

  it("describe signs with the origin's identity and works with env.snapshot absent", async () => {
    const h = makeHarness()
    const r = done(await h.handle({ target: describeTarget() }))
    expect(r.status).toBe(200)
    expect(headerOf(r, 'Content-Type')).toBe('application/json')
    expect(headerOf(r, 'Cache-Control')).toBe('no-store')
    expect(headerOf(r, 'Vary')).toBe('Origin')
    expect(headerOf(r, 'X-Content-Type-Options')).toBe('nosniff')
    expect(headerOf(r, 'Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(headerOf(r, 'Access-Control-Allow-Credentials')).toBeUndefined()
    expect(headerOf(r, 'Server')).toBeUndefined()
    expect(headerOf(r, 'Date')).toBeUndefined()
    const descriptor = verifyDescribeProof(r.body, { origin: ORIGIN, challenge: CHALLENGE })
    expect(descriptor.instanceId).toBe(identityHandle.instanceId)
    expect(descriptor.continuityKey).toBe(identityHandle.continuityKey)
    expect(h.state.snapshotCalls).toBe(0)
    expect(h.calls).toEqual(['identity'])
    expect(new TextEncoder().encode(r.body).length).toBeLessThanOrEqual(16384)
  })

  it('describe response is byte-identical with no hello, a non-matching hello and an expired record', async () => {
    const h = makeHarness()
    const plain = done(await h.handle({ target: describeTarget() }))
    const wrong = done(await h.handle({ target: describeTarget(`&hello=${b64uEncode(new Uint8Array(32).fill(1))}`) }))
    // An expired record is simply not in the live set the port searches.
    h.state.records = []
    const expired = done(
      await h.handle({
        target: describeTarget(`&hello=${helloMac(HELLO_KEY, { origin: ORIGIN, challenge: CHALLENGE, host: HOST4 })}`)
      })
    )
    expect(wrong).toEqual(plain)
    expect(expired).toEqual(plain)
    expect(headerOf(plain, 'BRC-185-Android-Ack')).toBeUndefined()
  })

  it('matching hello adds BRC-185-Android-Ack and consumes nothing', async () => {
    const h = makeHarness()
    h.state.records = [{ epoch: EPOCH, k: HELLO_KEY, n: NONCE }]
    const hello = helloMac(HELLO_KEY, { origin: ORIGIN, challenge: CHALLENGE, host: HOST4 })
    const plain = done(await h.handle({ target: describeTarget() }))
    const r = done(await h.handle({ target: describeTarget(`&hello=${hello}`) }))
    expect(r.status).toBe(200)
    expect(r.body).toBe(plain.body)
    expect(headerOf(r, 'BRC-185-Android-Ack')).toBe(
      describeAck(HELLO_KEY, {
        wallet: { instanceId: identityHandle.instanceId, continuityKey: identityHandle.continuityKey },
        origin: ORIGIN,
        challenge: CHALLENGE,
        host: HOST4,
        nonce: NONCE
      })
    )
    expect(r.headers.filter(([k]) => k !== 'BRC-185-Android-Ack')).toEqual(plain.headers)
    expect(h.calls.filter(c => c.startsWith('launches.'))).toEqual(['launches.matchHello'])
    expect(h.calls.some(c => c === 'launches.take' || c.startsWith('ledger.') || c.startsWith('registry.'))).toBe(false)
  })

  it('a hello made for another host or origin gets no ack', async () => {
    const h = makeHarness()
    h.state.records = [{ epoch: EPOCH, k: HELLO_KEY, n: NONCE }]
    const forOtherHost = helloMac(HELLO_KEY, { origin: ORIGIN, challenge: CHALLENGE, host: HOST6 })
    const forOtherOrigin = helloMac(HELLO_KEY, { origin: 'https://other.example', challenge: CHALLENGE, host: HOST4 })
    for (const hello of [forOtherHost, forOtherOrigin]) {
      const r = done(await h.handle({ target: describeTarget(`&hello=${hello}`) }))
      expect(r.status).toBe(200)
      expect(headerOf(r, 'BRC-185-Android-Ack')).toBeUndefined()
    }
  })

  it('describe advertises the responder (assertAdvertisesResponder passes for every spelling in Host)', async () => {
    const h = makeHarness()
    for (const host of [HOST4, HOST6, HOSTL]) {
      const r = done(await h.handle({ target: describeTarget(), headers: hostHeaders(host) }))
      expect(r.status).toBe(200)
      const d = verifyDescribeProof(r.body, { origin: ORIGIN, challenge: CHALLENGE })
      expect(() => assertAdvertisesResponder(d, { type: 'http-json', address: `http://${host}` })).not.toThrow()
      expect(d.endpoints.map(e => e.id)).toEqual(['json-ipv4', 'json-ipv6', 'json-localhost'])
    }
    h.state.bound = { port: PORT, ipv4: true, ipv6: false }
    const r = done(await h.handle({ target: describeTarget() }))
    expect(verifyDescribeProof(r.body, { origin: ORIGIN, challenge: CHALLENGE }).endpoints.map(e => e.id)).toEqual([
      'json-ipv4'
    ])
  })

  it('Access-Control-Expose-Headers on describe includes BRC-185-Android-Ack', async () => {
    const h = makeHarness()
    const r = done(await h.handle({ target: describeTarget() }))
    expect(headerOf(r, 'Access-Control-Expose-Headers')).toContain('BRC-185-Android-Ack')
  })
})
