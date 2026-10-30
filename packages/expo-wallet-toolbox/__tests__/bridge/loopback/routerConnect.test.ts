import { b64uDecode, b64uEncode } from '../../../core/bridge/protocol/base64url'
import { connectionError } from '../../../core/bridge/protocol/connectionError'
import { verifyConnectProof } from '../../../core/bridge/protocol/descriptor'
import { bindingSecret, connectAck, launchProof } from '../../../core/bridge/loopback/launchProof'
import type { RoutePlan, RouteResponse } from '../../../core/bridge/loopback'
import {
  CHALLENGE,
  EPOCH,
  HELLO_KEY,
  HOST4,
  NONCE,
  ORIGIN,
  done,
  headerOf,
  identityHandle,
  makeHarness,
  type Harness
} from './helpers/routerHarness'

const EPOCH2 = '8b6e3c2f-4d5a-4b7c-9eaf-1a2b3c4d5e6f'
const wallet = { instanceId: identityHandle.instanceId, continuityKey: identityHandle.continuityKey }
const SNAPSHOT = { accountContext: 'acct-1', walletRevision: '12' }

function proofFor(epoch: string, over: { origin?: string; challenge?: string; host?: string; k?: Uint8Array } = {}) {
  return launchProof(over.k ?? HELLO_KEY, {
    wallet,
    epoch,
    origin: over.origin ?? ORIGIN,
    challenge: over.challenge ?? CHALLENGE,
    host: over.host ?? HOST4,
    nonce: NONCE
  })
}

function body(over: Record<string, unknown> = {}, android: Record<string, unknown> = {}): string {
  return JSON.stringify({
    epoch: EPOCH,
    challenge: CHALLENGE,
    instanceId: wallet.instanceId,
    continuityKey: wallet.continuityKey,
    android: { launchProof: proofFor(EPOCH), ...android },
    ...over
  })
}

const JSON_HEADERS: [string, string][] = [
  ['host', HOST4],
  ['origin', ORIGIN],
  ['content-type', 'application/json']
]

function ready(h: Harness, epochs = [EPOCH]) {
  h.state.records = epochs.map(epoch => ({ epoch, k: HELLO_KEY, n: NONCE }))
  h.state.snapshot = SNAPSHOT
}

function connect(h: Harness, b: string = body(), headers: [string, string][] = JSON_HEADERS, id = 'c1') {
  return h.handle({ id, method: 'POST', target: '/.well-known/brc-wallet/connect', headers, body: b })
}

async function settle(p: RoutePlan): Promise<RouteResponse> {
  if (p.kind === 'respond') return done(p)
  return p.settled
}

const hasCors = (r: { headers: [string, string][] }) =>
  r.headers.some(([k]) => k.toLowerCase().startsWith('access-control-'))

describe('loopback router connect', () => {
  it('non-JSON content type is 415 and touches no launch record', async () => {
    const h = makeHarness()
    ready(h)
    for (const ct of ['text/plain', 'application/json; charset=utf-8', 'application/x-www-form-urlencoded']) {
      const r = done(
        await connect(h, body(), [
          ['host', HOST4],
          ['origin', ORIGIN],
          ['content-type', ct]
        ])
      )
      expect(r.status).toBe(415)
    }
    const none = done(
      await connect(h, body(), [
        ['host', HOST4],
        ['origin', ORIGIN]
      ])
    )
    expect(none.status).toBe(415)
    expect(h.calls.filter(c => c.startsWith('launches.'))).toEqual([])
    expect(h.state.used.size).toBe(0)
  })

  it('a connect body over 4096 B is 413 and touches no launch record', async () => {
    const h = makeHarness()
    ready(h)
    const r = done(await connect(h, body({}, { reconnectToken: 'x'.repeat(4100) })))
    expect(r.status).toBe(413)
    expect(JSON.parse(r.body).code).toBe('RESOURCE_LIMIT')
    expect(h.calls.filter(c => c.startsWith('launches.'))).toEqual([])
    // A multibyte body is measured in bytes, not characters.
    const multi = body({}, { reconnectToken: 'é'.repeat(2100) })
    expect(multi.length).toBeLessThan(4096)
    expect(done(await connect(h, multi)).status).toBe(413)
  })

  it('identity mismatch is 412 and creates no binding', async () => {
    const h = makeHarness()
    ready(h)
    for (const over of [
      { instanceId: '99999999-2222-4333-8444-555555555555' },
      { continuityKey: b64uEncode(new Uint8Array(32)) }
    ]) {
      const r = done(await connect(h, body(over)))
      expect(r.status).toBe(412)
      expect(JSON.parse(r.body).code).toBe('PROVIDER_CHANGED')
      expect(hasCors(r)).toBe(true)
    }
    expect(h.calls).not.toContain('connectExplicit')
    expect(h.calls).not.toContain('launches.take')
  })

  it('unknown or duplicate member is 400', async () => {
    const h = makeHarness()
    ready(h)
    const bad = [
      body({ extra: 1 }),
      body({}, { extra: 1 }),
      body({ android: null }),
      body({ challenge: null }),
      body({}, { reconnectToken: null }),
      body({}, { launchProof: 5 }),
      body({ epoch: 'not-an-epoch' }),
      body({ epoch: EPOCH.toUpperCase() }),
      body({ challenge: 'AAAA' }),
      '{"epoch":"x","epoch":"y"}',
      '[]',
      'not json',
      JSON.stringify({ epoch: EPOCH })
    ]
    for (const b of bad) {
      const r = done(await connect(h, b))
      expect(r.status).toBe(400)
      expect(JSON.parse(r.body).code).toBe('PROTOCOL_ERROR')
    }
    expect(h.calls).not.toContain('launches.take')
  })

  it('unsettled gate answers 429 Retry-After 5 before the launch proof is burnt', async () => {
    const h = makeHarness()
    ready(h)
    h.state.gateBusy.add(ORIGIN)
    const r = done(await connect(h))
    expect(r.status).toBe(429)
    expect(headerOf(r, 'Retry-After')).toBe('5')
    expect(JSON.parse(r.body)).toMatchObject({ code: 'RESOURCE_LIMIT', delivery: 'not-sent' })
    expect(h.state.used.size).toBe(0)
    expect(h.calls).not.toContain('launches.take')
    // The same launch still works once the gate opens.
    h.state.gateBusy.clear()
    expect(done(await connect(h)).status).toBe(200)
  })

  it('bad, reused, expired or other-origin launch proof is 403 launch proof required (one fixed message)', async () => {
    const messages = new Set<string>()
    const expectRefused = async (h: Harness, b: string, headers?: [string, string][]) => {
      const r = done(await connect(h, b, headers))
      expect(r.status).toBe(403)
      messages.add(JSON.parse(r.body).message)
      expect(JSON.parse(r.body).code).toBe('CONFIGURATION_ERROR')
    }
    // bad MAC
    let h = makeHarness()
    ready(h)
    await expectRefused(h, body({}, { launchProof: proofFor(EPOCH, { k: new Uint8Array(32).fill(1) }) }))
    // reused
    h = makeHarness()
    ready(h)
    expect(done(await connect(h)).status).toBe(200)
    h.state.gateBusy.clear()
    await expectRefused(h, body())
    // expired or unknown epoch
    h = makeHarness()
    ready(h, [])
    await expectRefused(h, body())
    // proof minted for another origin / host / challenge
    h = makeHarness()
    ready(h)
    await expectRefused(h, body({}, { launchProof: proofFor(EPOCH, { origin: 'https://other.example' }) }))
    h = makeHarness()
    ready(h)
    await expectRefused(h, body({}, { launchProof: proofFor(EPOCH, { host: '[::1]:3321' }) }))
    h = makeHarness()
    ready(h)
    await expectRefused(h, body({}, { launchProof: proofFor(EPOCH, { challenge: b64uEncode(new Uint8Array(32)) }) }))
    expect(messages.size).toBe(1)
    expect([...messages][0]).toBe('launch proof required')
    expect(h.calls).not.toContain('connectExplicit')
  })

  it('five bad proofs do not lock out a good one', async () => {
    const h = makeHarness()
    h.state.records = [
      ...[1, 2, 3, 4, 5].map(i => ({
        epoch: `8b6e3c2f-4d5a-4b7c-9eaf-1a2b3c4d5e0${i}`,
        k: HELLO_KEY,
        n: NONCE
      })),
      { epoch: EPOCH, k: HELLO_KEY, n: NONCE }
    ]
    h.state.snapshot = SNAPSHOT
    for (let i = 1; i <= 5; i++) {
      const epoch = `8b6e3c2f-4d5a-4b7c-9eaf-1a2b3c4d5e0${i}`
      const r = done(await connect(h, body({ epoch }, { launchProof: 'AAAA' })))
      expect(r.status).toBe(403)
    }
    expect(done(await connect(h)).status).toBe(200)
  })

  it('hostAttached false parks and attached+none answers 503', async () => {
    const h = makeHarness()
    ready(h)
    h.state.readiness = 'none-fail'
    const r = done(await connect(h))
    expect(r.status).toBe(503)
    expect(JSON.parse(r.body)).toMatchObject({ code: 'CONFIGURATION_ERROR', delivery: 'not-sent' })
    expect(h.calls).not.toContain('session.parkConnect')
    expect(h.calls).not.toContain('connectExplicit')

    const h2 = makeHarness()
    ready(h2)
    h2.state.readiness = 'park'
    let release!: () => void
    h2.state.park = () => new Promise(res => (release = () => res('resume')))
    const plan = await connect(h2)
    expect(plan.kind).toBe('hold')
    expect(h2.calls).not.toContain('connectExplicit')
    await Promise.resolve()
    release()
    const r2 = await settle(plan)
    expect(r2.status).toBe(200)
    expect(h2.state.connected).toHaveLength(1)
  })

  it('parkConnect full answers 429', async () => {
    const h = makeHarness()
    ready(h)
    h.state.readiness = 'park'
    h.state.park = async () => 'full'
    const r = await settle(await connect(h))
    expect(r.status).toBe(429)
    expect(JSON.parse(r.body).code).toBe('RESOURCE_LIMIT')
    expect(h.calls).not.toContain('connectExplicit')
  })

  it('parkConnect unavailable or dropped answers 503 CONFIGURATION_ERROR not-sent', async () => {
    for (const result of ['unavailable', 'dropped'] as const) {
      const h = makeHarness()
      ready(h)
      h.state.readiness = 'park'
      h.state.park = async () => result
      const r = await settle(await connect(h))
      expect(r.status).toBe(503)
      expect(JSON.parse(r.body)).toMatchObject({ code: 'CONFIGURATION_ERROR', delivery: 'not-sent' })
      expect(h.calls).not.toContain('connectExplicit')
    }
  })

  it('second parked connect gets 429 in the same turn as connectExplicit', async () => {
    const h = makeHarness()
    ready(h, [EPOCH, EPOCH2])
    h.state.readiness = 'park'
    const releases: (() => void)[] = []
    h.state.park = () => new Promise(res => releases.push(() => res('resume')))
    const p1 = await connect(h, body(), JSON_HEADERS, 'c1')
    const p2 = await connect(h, body({ epoch: EPOCH2 }, { launchProof: proofFor(EPOCH2) }), JSON_HEADERS, 'c2')
    expect(p1.kind).toBe('hold')
    expect(p2.kind).toBe('hold')
    // Both passed the first gate check; both are parked.
    expect(h.state.connected).toHaveLength(0)
    // Release in one synchronous turn.
    releases.forEach(r => r())
    const [r1, r2] = await Promise.all([settle(p1), settle(p2)])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(429)
    expect(headerOf(r2, 'Retry-After')).toBe('5')
    expect(h.state.connected.map(c => c.epoch)).toEqual([EPOCH])
    expect(h.state.opened.map(o => o.epoch)).toEqual([EPOCH])
  })

  it('success returns signConnect body and BRC-185-Android-Ack with Expose-Headers', async () => {
    const h = makeHarness()
    ready(h)
    const r = done(await connect(h))
    expect(r.status).toBe(200)
    expect(headerOf(r, 'Content-Type')).toBe('application/json')
    expect(headerOf(r, 'Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(headerOf(r, 'Access-Control-Expose-Headers')).toContain('BRC-185-Android-Ack')
    expect(headerOf(r, 'Cache-Control')).toBe('no-store')
    const msg = { wallet, epoch: EPOCH, origin: ORIGIN, challenge: CHALLENGE, host: HOST4, nonce: NONCE }
    expect(headerOf(r, 'BRC-185-Android-Ack')).toBe(connectAck(HELLO_KEY, msg))
    const parsed = JSON.parse(r.body)
    expect(parsed.epoch).toBe(EPOCH)
    expect(parsed.challenge).toBe(CHALLENGE)
    verifyConnectProof(r.body, { origin: ORIGIN, epoch: EPOCH, challenge: CHALLENGE, expectedIdentity: wallet })
    // The binding secret is derived from the same message and handed to the ledger, never sent.
    expect(h.state.opened).toHaveLength(1)
    expect(b64uEncode(h.state.opened[0].secret)).toBe(bindingSecret(HELLO_KEY, msg))
    expect(h.state.opened[0].origin).toBe(ORIGIN)
    expect(r.body).not.toContain(bindingSecret(HELLO_KEY, msg))
    expect(h.calls).toEqual(expect.arrayContaining(['gate.claim', 'session.onConnect']))
  })

  it('connectExplicit receives launchProofVerified true and the reconnect token', async () => {
    const h = makeHarness()
    ready(h)
    expect(done(await connect(h, body({}, { reconnectToken: 'tok-1' }))).status).toBe(200)
    expect(h.state.connected).toEqual([
      {
        epoch: EPOCH,
        transportId: 'android-loopback',
        applicationOrigin: ORIGIN,
        attestation: 'unattested',
        instanceId: wallet.instanceId,
        continuityKey: wallet.continuityKey,
        accountContext: 'acct-1',
        walletRevision: '12',
        launchProofVerified: true,
        reconnectToken: 'tok-1'
      }
    ])
    // No token: the member is absent.
    const h2 = makeHarness()
    ready(h2)
    expect(done(await connect(h2)).status).toBe(200)
    expect('reconnectToken' in h2.state.connected[0]).toBe(false)
  })

  it('connectExplicit ConnectionErrors map by the status table', async () => {
    const h = makeHarness()
    ready(h)
    h.state.connectError = connectionError('RESOURCE_LIMIT', 'too many', 'not-sent')
    const r = done(await connect(h))
    expect(r.status).toBe(429)
    expect(JSON.parse(r.body).code).toBe('RESOURCE_LIMIT')
    expect(hasCors(r)).toBe(true)
    expect(h.calls).not.toContain('gate.claim')
    expect(h.state.opened).toHaveLength(0)
  })

  it('client gone while a connect is parked (ledger.markGone) creates no binding', async () => {
    const h = makeHarness()
    ready(h)
    h.state.readiness = 'park'
    let release!: () => void
    h.state.park = () => new Promise(res => (release = () => res('resume')))
    const plan = await connect(h, body(), JSON_HEADERS, 'gone-1')
    h.state.gone.add('gone-1')
    release()
    const r = await settle(plan)
    expect(r.status).toBe(410)
    expect(h.calls).not.toContain('connectExplicit')
    expect(h.calls).not.toContain('gate.claim')
    expect(h.state.gone.has('gone-1')).toBe(false)
  })

  it('b64uDecode of the binding secret is 32 bytes', async () => {
    const h = makeHarness()
    ready(h)
    done(await connect(h))
    expect(h.state.opened[0].secret).toHaveLength(32)
    expect(
      b64uDecode(
        bindingSecret(HELLO_KEY, {
          wallet,
          epoch: EPOCH,
          origin: ORIGIN,
          challenge: CHALLENGE,
          host: HOST4,
          nonce: NONCE
        })
      )
    ).toEqual(h.state.opened[0].secret)
  })
})
