import { b64uEncode } from '../../../core/bridge/protocol/base64url'
import { connectionError, type ConnectionError } from '../../../core/bridge/protocol/connectionError'
import { MAX_BRIDGE_REQUEST_BYTES } from '../../../core/bridge/protocol/limits'
import { launchProof } from '../../../core/bridge/loopback/launchProof'
import type { Outcome } from '../../../core/bridge/dispatcher'
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

const wallet = { instanceId: identityHandle.instanceId, continuityKey: identityHandle.continuityKey }
const SNAPSHOT = { accountContext: 'acct-1', walletRevision: '12' }
const OTHER_ORIGIN = 'https://other.example'

interface Bound {
  epoch: string
  secret: string
}

/** A real connect through the router: the ledger, the registry and the binding secret all come from it. */
async function connected(h: Harness, epoch = EPOCH): Promise<Bound> {
  await h.ready
  h.state.records = [{ epoch, k: HELLO_KEY, n: NONCE }]
  h.state.snapshot = SNAPSHOT
  const proof = launchProof(HELLO_KEY, {
    wallet,
    epoch,
    origin: ORIGIN,
    challenge: CHALLENGE,
    host: HOST4,
    nonce: NONCE
  })
  const plan = await h.handle({
    method: 'POST',
    target: '/.well-known/brc-wallet/connect',
    headers: [
      ['host', HOST4],
      ['origin', ORIGIN],
      ['content-type', 'application/json']
    ],
    body: JSON.stringify({
      epoch,
      challenge: CHALLENGE,
      instanceId: wallet.instanceId,
      continuityKey: wallet.continuityKey,
      android: { launchProof: proof }
    })
  })
  expect(done(plan).status).toBe(200)
  h.state.gateBusy.clear()
  const opened = h.state.opened.find(o => o.epoch === epoch)!
  return { epoch, secret: b64uEncode(opened.secret) }
}

type Headers = [string, string][]

function authHeaders(b: Bound, over: { origin?: string; contentType?: string | null } = {}): Headers {
  const out: Headers = [
    ['host', HOST4],
    ['origin', over.origin ?? ORIGIN],
    ['brc-185-epoch', b.epoch],
    ['brc-185-instance', wallet.instanceId],
    ['brc-185-key', wallet.continuityKey],
    ['brc-185-android-binding', b.secret]
  ]
  if (over.contentType !== null) out.push(['content-type', over.contentType ?? 'application/json'])
  return out
}

function without(headers: Headers, name: string): Headers {
  return headers.filter(([k]) => k !== name)
}

function replace(headers: Headers, name: string, value: string): Headers {
  return headers.map(([k, v]) => (k === name ? [k, value] : [k, v]))
}

function rpc(
  h: Harness,
  headers: Headers,
  o: { method?: string; body?: string; id?: string } = {}
): Promise<RoutePlan> {
  return h.handle({
    id: o.id ?? 'r1',
    method: 'POST',
    target: `/brc185/v1/rpc/${o.method ?? 'getHeight'}`,
    headers,
    body: o.body ?? '{}'
  })
}

function del(h: Harness, headers: Headers, epoch: string): Promise<RoutePlan> {
  return h.handle({ method: 'DELETE', target: `/.well-known/brc-wallet/connect/${epoch}`, headers, body: '' })
}

const hasCors = (r: { headers: [string, string][] }) =>
  r.headers.some(([k]) => k.toLowerCase().startsWith('access-control-'))

async function settle(p: RoutePlan): Promise<RouteResponse> {
  if (p.kind === 'respond') return done(p)
  return p.settled
}

/** A dispatch whose outcome the test supplies later. */
function deferredDispatch(h: Harness) {
  const requests: Parameters<NonNullable<Harness['state']['dispatch']>>[0][] = []
  const resolvers: ((o: Outcome) => void)[] = []
  h.state.dispatch = (input => {
    requests.push(input)
    return new Promise<Outcome>(res => resolvers.push(res))
  }) as NonNullable<Harness['state']['dispatch']>
  return {
    requests,
    resolve: (o: Outcome) => resolvers[resolvers.length - 1](o),
    resolveAll: (o: Outcome) => resolvers.forEach(r => r(o))
  }
}

function dispatchReturns(h: Harness, outcome: Outcome) {
  h.state.dispatch = (async () => outcome) as NonNullable<Harness['state']['dispatch']>
}

const tick = () => new Promise(r => setTimeout(r, 0))

describe('loopback router RPC authorisation', () => {
  it('each of the four headers missing, wrong, repeated or retired answers 412 like an unknown epoch', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    deferredDispatch(h)
    const unknown = done(await rpc(h, authHeaders({ epoch: '9c7e4d3a-5e6b-4c8d-8fa0-2b3c4d5e6f70', secret: b.secret })))
    expect(unknown.status).toBe(412)
    const names = ['brc-185-epoch', 'brc-185-instance', 'brc-185-key', 'brc-185-android-binding']
    const good = authHeaders(b)
    for (const name of names) {
      const wrongValue =
        name === 'brc-185-epoch'
          ? '9c7e4d3a-5e6b-4c8d-8fa0-2b3c4d5e6f70'
          : name === 'brc-185-instance'
            ? '99999999-2222-4333-8444-555555555555'
            : name === 'brc-185-key'
              ? b64uEncode(new Uint8Array(32))
              : b64uEncode(new Uint8Array(32).fill(1))
      const value = good.find(([k]) => k === name)![1]
      const variants: Headers[] = [
        without(good, name),
        replace(good, name, wrongValue),
        [...good, [name, value]] // repeated: a duplicate is as good as missing
      ]
      for (const headers of variants) {
        const r = done(await rpc(h, headers))
        expect(r.status).toBe(412)
        expect(JSON.parse(r.body)).toMatchObject({ code: 'PROVIDER_CHANGED', delivery: 'not-sent' })
        expect(hasCors(r)).toBe(false)
      }
    }
    expect(h.calls).not.toContain('dispatch')
    // retired: the binding is closed, the same answer
    expect(done(await del(h, authHeaders(b), b.epoch)).status).toBe(204)
    const retired = done(await rpc(h, authHeaders(b)))
    expect(retired.status).toBe(412)
    expect(hasCors(retired)).toBe(false)
  })

  it('wrong BRC-185-Android-Binding is indistinguishable from unknown epoch', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    const wrong = done(await rpc(h, replace(authHeaders(b), 'brc-185-android-binding', b64uEncode(new Uint8Array(32)))))
    const missingEpoch = '9c7e4d3a-5e6b-4c8d-8fa0-2b3c4d5e6f70'
    const unknown = done(await rpc(h, replace(authHeaders(b), 'brc-185-epoch', missingEpoch)))
    expect(wrong.status).toBe(unknown.status)
    expect(wrong.headers).toEqual(unknown.headers)
    expect(JSON.parse(wrong.body)).toEqual({ ...JSON.parse(unknown.body), epoch: b.epoch })
    // and against a never-bound epoch with the same header spelling the bodies are byte-identical
    const wrongB = done(
      await rpc(h, replace(authHeaders({ epoch: missingEpoch, secret: b.secret }), 'brc-185-epoch', missingEpoch))
    )
    expect(wrongB.body).toBe(unknown.body)
  })

  it('another origin with every header right gets 412 and no CORS', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    const r = done(await rpc(h, authHeaders(b, { origin: OTHER_ORIGIN })))
    expect(r.status).toBe(412)
    expect(hasCors(r)).toBe(false)
    expect(h.calls).not.toContain('dispatch')
  })

  it('CORS on RPC only for the binding origin, with the token header exposed', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    dispatchReturns(h, { ok: true, result: { height: 5 } })
    const r = await settle(await rpc(h, authHeaders(b)))
    expect(headerOf(r, 'Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(headerOf(r, 'Access-Control-Expose-Headers')).toBe('BRC-185-Reconnect-Token')
    expect(headerOf(r, 'Access-Control-Allow-Credentials')).toBeUndefined()
    expect(headerOf(r, 'Vary')).toBe('Origin')
    expect(headerOf(r, 'Cache-Control')).toBe('no-store')
  })
})

describe('loopback router RPC request handling', () => {
  it('RPC with a content type other than application/json is 415', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    for (const ct of ['text/plain', 'application/json; charset=utf-8', null]) {
      const r = done(await rpc(h, authHeaders(b, { contentType: ct })))
      expect(r.status).toBe(415)
    }
    expect(h.calls).not.toContain('dispatch')
  })

  it('unknown method is 404 PROTOCOL_ERROR', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    for (const method of ['nope', 'toString', 'constructor']) {
      const r = done(await rpc(h, authHeaders(b), { method }))
      expect(r.status).toBe(404)
      expect(JSON.parse(r.body)).toMatchObject({ code: 'PROTOCOL_ERROR', delivery: 'not-sent' })
    }
    expect(h.calls).not.toContain('dispatch')
  })

  it('a bad body is 400, an oversize body 413 measured in bytes', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    for (const body of ['not json', '{"a":1,"a":2}', '']) {
      const r = done(await rpc(h, authHeaders(b), { body }))
      expect(r.status).toBe(400)
      expect(JSON.parse(r.body).code).toBe('PROTOCOL_ERROR')
    }
    // 2.7 M two-byte characters: fewer characters than the cap, more bytes
    const multi = JSON.stringify({ p: 'é'.repeat(Math.floor(MAX_BRIDGE_REQUEST_BYTES / 2) + 10) })
    expect(multi.length).toBeLessThan(MAX_BRIDGE_REQUEST_BYTES)
    const over = done(await rpc(h, authHeaders(b), { body: multi }))
    expect(over.status).toBe(413)
    expect(JSON.parse(over.body)).toMatchObject({ code: 'RESOURCE_LIMIT', delivery: 'not-sent' })
    expect(h.calls).not.toContain('dispatch')
  })

  it('RPC holds the response until the Outcome', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    const d = deferredDispatch(h)
    const plan = await rpc(h, authHeaders(b), { method: 'getHeaderForHeight', body: '{"height":7}', id: 'req-9' })
    expect(plan.kind).toBe('hold')
    if (plan.kind !== 'hold') return
    expect(plan.id).toBe('req-9')
    expect(d.requests).toHaveLength(1)
    expect(d.requests[0]).toEqual({
      transport: 'android-loopback',
      request: {
        epoch: b.epoch,
        instanceId: wallet.instanceId,
        continuityKey: wallet.continuityKey,
        origin: ORIGIN,
        method: 'getHeaderForHeight',
        args: { height: 7 },
        sizeBytes: 12,
        beforeCall: expect.any(Function)
      }
    })
    let settled = false
    void plan.settled.then(() => (settled = true))
    await tick()
    expect(settled).toBe(false)
    expect(h.state.inFlightNow.get(b.epoch)).toBe(1)
    d.resolve({ ok: true, result: { header: 'aa' } })
    const r = await plan.settled
    expect(r.status).toBe(200)
    expect(headerOf(r, 'Content-Type')).toBe('application/json')
    expect(JSON.parse(r.body)).toEqual({ header: 'aa' })
    expect(h.state.inFlightNow.get(b.epoch)).toBe(0)
  })

  it('a request whose page left before consent makes beforeCall reject CONNECTION_CLOSED not-sent', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    const d = deferredDispatch(h)
    const gone = await rpc(h, authHeaders(b), { id: 'gone-1' })
    const here = await rpc(h, authHeaders(b), { id: 'here-1' })
    h.state.gone.add('gone-1')
    await expect(d.requests[0].request.beforeCall!()).rejects.toMatchObject({
      domain: 'brc185',
      code: 'CONNECTION_CLOSED',
      delivery: 'not-sent'
    })
    // a request that is still there passes
    await expect(d.requests[1].request.beforeCall!()).resolves.toBeUndefined()
    d.resolveAll({ ok: true, result: {} })
    await settle(gone)
    await settle(here)
    // the gone mark is cleared once its request has been answered
    expect(h.state.gone.has('gone-1')).toBe(false)
  })
})

describe('loopback router RPC outcome mapping', () => {
  const cases: Array<[string, Outcome, number]> = [
    ['ok', { ok: true, result: { height: 1 } }, 200],
    [
      'walletError',
      {
        ok: false,
        walletError: { isError: true, code: 6, name: 'WERR_INVALID_PARAMETER', message: 'x' } as never,
        delivery: 'not-sent'
      },
      400
    ],
    ['PROVIDER_CHANGED', { ok: false, connectionError: connectionError('PROVIDER_CHANGED', 'x', 'not-sent') }, 412],
    ['CONNECTION_CLOSED', { ok: false, connectionError: connectionError('CONNECTION_CLOSED', 'x', 'not-sent') }, 410],
    ['DISCONNECTED', { ok: false, connectionError: connectionError('DISCONNECTED', 'x', 'not-sent') }, 410],
    ['USER_CANCELLED', { ok: false, connectionError: connectionError('USER_CANCELLED', 'x', 'not-sent') }, 403],
    ['RESOURCE_LIMIT', { ok: false, connectionError: connectionError('RESOURCE_LIMIT', 'x', 'not-sent') }, 429],
    ['RESOURCE_LIMIT unknown', { ok: false, connectionError: connectionError('RESOURCE_LIMIT', 'x', 'unknown') }, 502],
    ['PROTOCOL_ERROR', { ok: false, connectionError: connectionError('PROTOCOL_ERROR', 'x', 'unknown') }, 400],
    [
      'CONFIGURATION_ERROR',
      { ok: false, connectionError: connectionError('CONFIGURATION_ERROR', 'x', 'not-sent') },
      503
    ]
  ]

  it.each(cases)('%s', async (_name, outcome, status) => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    dispatchReturns(h, outcome)
    const r = await settle(await rpc(h, authHeaders(b)))
    expect(r.status).toBe(status)
    const body = JSON.parse(r.body)
    if (outcome.ok) expect(body).toEqual(outcome.result)
    else if ('walletError' in outcome) expect(body).toEqual(outcome.walletError)
    else expect(body).toEqual(outcome.connectionError as ConnectionError)
    expect(hasCors(r)).toBe(true)
  })

  it('a result over 5 MiB, or one that will not serialise, is 502 RESOURCE_LIMIT unknown', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    dispatchReturns(h, { ok: true, result: 'x'.repeat(MAX_BRIDGE_REQUEST_BYTES + 1) })
    const big = await settle(await rpc(h, authHeaders(b)))
    expect(big.status).toBe(502)
    expect(JSON.parse(big.body)).toMatchObject({ code: 'RESOURCE_LIMIT', delivery: 'unknown' })
    // multibyte: fewer characters than the cap, more bytes
    dispatchReturns(h, { ok: true, result: 'é'.repeat(MAX_BRIDGE_REQUEST_BYTES / 2 + 10) })
    expect((await settle(await rpc(h, authHeaders(b)))).status).toBe(502)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    dispatchReturns(h, { ok: true, result: cyclic })
    const bad = await settle(await rpc(h, authHeaders(b)))
    expect(bad.status).toBe(502)
    expect(JSON.parse(bad.body).delivery).toBe('unknown')
    dispatchReturns(h, { ok: true, result: undefined })
    expect((await settle(await rpc(h, authHeaders(b)))).status).toBe(502)
  })

  it('an exception after dispatch is 500 CONFIGURATION_ERROR unknown, before dispatch not-sent', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    h.state.dispatch = (async () => {
      throw new Error('secret path /Users/x/y.ts')
    }) as NonNullable<Harness['state']['dispatch']>
    const after = await settle(await rpc(h, authHeaders(b)))
    expect(after.status).toBe(500)
    expect(JSON.parse(after.body)).toMatchObject({ code: 'CONFIGURATION_ERROR', delivery: 'unknown' })
    expect(after.body).not.toContain('/Users')
    h.state.dispatch = (() => {
      throw new Error('sync failure')
    }) as unknown as NonNullable<Harness['state']['dispatch']>
    const before = await settle(await rpc(h, authHeaders(b)))
    expect(before.status).toBe(500)
    expect(JSON.parse(before.body)).toMatchObject({ code: 'CONFIGURATION_ERROR', delivery: 'not-sent' })
    expect(h.state.inFlightNow.get(b.epoch)).toBe(0)
  })

  it('reconnect token header is attached on the next response, exposed, and kept until confirmWritten', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    dispatchReturns(h, { ok: true, result: {} })
    expect(headerOf(await settle(await rpc(h, authHeaders(b))), 'BRC-185-Reconnect-Token')).toBeUndefined()
    h.state.tokens.set(b.epoch, 'tok-1')
    const first = await settle(await rpc(h, authHeaders(b)))
    expect(headerOf(first, 'BRC-185-Reconnect-Token')).toBe('tok-1')
    expect(headerOf(first, 'Access-Control-Expose-Headers')).toContain('BRC-185-Reconnect-Token')
    // the router never confirms: a failed write must keep the token
    expect(h.calls).not.toContain('outbox.confirmWritten')
    expect(headerOf(await settle(await rpc(h, authHeaders(b))), 'BRC-185-Reconnect-Token')).toBe('tok-1')
    h.env.tokenOutbox.confirmWritten(b.epoch)
    expect(headerOf(await settle(await rpc(h, authHeaders(b))), 'BRC-185-Reconnect-Token')).toBeUndefined()
  })

  it('the token is taken when the parked response is written, not when the request arrives', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    const d = deferredDispatch(h)
    const plan = await rpc(h, authHeaders(b))
    h.state.tokens.set(b.epoch, 'minted-on-approve')
    d.resolve({ ok: true, result: {} })
    expect(headerOf(await settle(plan), 'BRC-185-Reconnect-Token')).toBe('minted-on-approve')
  })

  it('an unauthorised request never reads the token', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    h.state.tokens.set(b.epoch, 'tok')
    const r = done(await rpc(h, replace(authHeaders(b), 'brc-185-android-binding', b64uEncode(new Uint8Array(32)))))
    expect(headerOf(r, 'BRC-185-Reconnect-Token')).toBeUndefined()
    expect(h.calls).not.toContain('outbox.take')
  })
})

describe('loopback router disconnect', () => {
  it('DELETE closes the binding, 204, second DELETE 412', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    const r = done(await del(h, authHeaders(b, { contentType: null }), b.epoch))
    expect(r.status).toBe(204)
    expect(r.body).toBe('')
    expect(headerOf(r, 'Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(h.env.registry.live()).toHaveLength(0)
    expect(h.calls).toEqual(
      expect.arrayContaining(['ledger.close', 'gate.release', 'outbox.drop', 'session.onBindingClosed'])
    )
    const again = done(await del(h, authHeaders(b, { contentType: null }), b.epoch))
    expect(again.status).toBe(412)
    expect(JSON.parse(again.body).code).toBe('PROVIDER_CHANGED')
  })

  it('DELETE whose path epoch differs from BRC-185-Epoch is 412 and leaves the binding live', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    const r = done(await del(h, authHeaders(b), '9c7e4d3a-5e6b-4c8d-8fa0-2b3c4d5e6f70'))
    expect(r.status).toBe(412)
    expect(JSON.parse(r.body).code).toBe('PROVIDER_CHANGED')
    expect(h.env.registry.live()).toHaveLength(1)
    expect(h.calls).not.toContain('ledger.close')
  })

  it('DELETE with a wrong secret or another origin is 412 and closes nothing', async () => {
    const h = makeHarness({ realRegistry: true })
    const b = await connected(h)
    const wrong = done(
      await del(h, replace(authHeaders(b), 'brc-185-android-binding', b64uEncode(new Uint8Array(32))), b.epoch)
    )
    expect(wrong.status).toBe(412)
    expect(hasCors(wrong)).toBe(false)
    expect(done(await del(h, authHeaders(b, { origin: OTHER_ORIGIN }), b.epoch)).status).toBe(412)
    expect(h.env.registry.live()).toHaveLength(1)
  })
})
