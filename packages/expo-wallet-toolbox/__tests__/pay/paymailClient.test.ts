import { createLegacyPaymailClient } from '../../core/pay/paymail/client'
import type { CapabilityDiscovery } from '../../core/identity/handleRegistry/resolver'
import { notOk, ok, transport } from '../__helpers__/fakeTransport'

const DEST_TPL = 'https://cloud.handcash.io/p2p/dest/{alias}@{domain.tld}'
const BEEF_TPL = 'https://cloud.handcash.io/p2p/beef/{alias}@{domain.tld}'
const okDiscovery = (over: Record<string, unknown> = {}): CapabilityDiscovery => ({
  kind: 'ok',
  domain: 'handcash.io',
  origin: 'https://cloud.handcash.io',
  capabilities: { '2a40af698840': DEST_TPL, '5c55a7fdb7bb': BEEF_TPL, ...over }
})
const resolverOf = (d: CapabilityDiscovery) => ({ discoverCapabilities: jest.fn(async () => d) })
const GOOD = { outputs: [{ script: '76a914aa88ac', satoshis: 1000 }], reference: 'ref-1' }
const TXID = 'ab'.repeat(32)

function clientWith(rules: Parameters<typeof transport>[0], d: CapabilityDiscovery = okDiscovery()) {
  const t = transport(rules)
  const client = createLegacyPaymailClient({ resolver: resolverOf(d), fetchImpl: t.fetchImpl })
  return { client, ...t }
}
const destRule = (res: () => Promise<Response>): [string, () => Promise<Response>] => ['/p2p/dest/', res]
const textRes = (status: number, text: string) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token')
    },
    text: async () => text
  }) as unknown as Response

describe('getP2pDestination alias and server text', () => {
  it('accepts aliases that start with _ . or -', async () => {
    for (const a of ['_bob', '.bob', '-bob']) {
      const { client, calls } = clientWith([destRule(async () => ok(GOOD))])
      const res = await client.getP2pDestination(`${a}@handcash.io`, 1000)
      expect(res.kind).toBe('ok')
      expect(calls).toHaveLength(1)
    }
  })

  it('still rejects / ? # whitespace and a second @ in the alias', async () => {
    for (const p of ['a/b@handcash.io', 'a?b@handcash.io', 'a#b@handcash.io', 'a b@handcash.io', '+a@handcash.io']) {
      const { client, calls } = clientWith([destRule(async () => ok(GOOD))])
      expect(await client.getP2pDestination(p, 1000)).toMatchObject({ kind: 'failed', reason: 'invalid_paymail' })
      expect(calls).toHaveLength(0)
    }
  })

  it('bounds and cleans the host message', async () => {
    const hostile = `Your wallet is locked\u0007\n${'x'.repeat(250_000)}`
    const { client } = clientWith([destRule(async () => notOk(400, { message: hostile }))])
    const res = (await client.getP2pDestination('bob@handcash.io', 1000)) as any
    expect(res.message.length).toBeLessThanOrEqual(200)
    expect(res.message).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(res.message.startsWith('Your wallet is locked')).toBe(true)
  })

  it('bounds the message of a refused POST too', async () => {
    const { client } = clientWith([['/p2p/beef/', async () => notOk(503, { message: 'y'.repeat(5000) })]])
    const res = (await client.postBeef({ endpoint: 'https://cloud.handcash.io/p2p/beef/a@b.io', beefHex: 'aa', reference: 'r' })) as any
    expect(res.message.length).toBeLessThanOrEqual(200)
  })
})

describe('getP2pDestination', () => {
  it('asks the destination URL with alias and domain filled, and posts {"satoshis":1000}', async () => {
    const { client, calls, inits } = clientWith([destRule(async () => ok(GOOD))])
    await client.getP2pDestination('Deggen@HandCash.io', 1000)
    expect(calls).toEqual(['https://cloud.handcash.io/p2p/dest/deggen@handcash.io'])
    expect(inits[0]?.method).toBe('POST')
    expect(inits[0]?.body).toBe('{"satoshis":1000}')
  })

  it('returns outputs, reference and the filled beef endpoint', async () => {
    const { client } = clientWith([destRule(async () => ok(GOOD))])
    expect(await client.getP2pDestination('deggen@handcash.io', 1000)).toEqual({
      kind: 'ok',
      destination: {
        outputs: GOOD.outputs,
        reference: 'ref-1',
        beefEndpoint: 'https://cloud.handcash.io/p2p/beef/deggen@handcash.io'
      }
    })
  })

  const bad: [string, unknown][] = [
    ['a script that is not hex', { ...GOOD, outputs: [{ script: 'zz', satoshis: 1000 }] }],
    ['an odd-length script', { ...GOOD, outputs: [{ script: 'abc', satoshis: 1000 }] }],
    ['an empty script', { ...GOOD, outputs: [{ script: '', satoshis: 1000 }] }],
    ['a zero amount', { ...GOOD, outputs: [{ script: 'aa', satoshis: 0 }] }],
    ['a fractional amount', { ...GOOD, outputs: [{ script: 'aa', satoshis: 1000.5 }] }],
    ['a negative amount', { ...GOOD, outputs: [{ script: 'aa', satoshis: -1000 }] }],
    [
      'amounts that do not add up',
      {
        ...GOOD,
        outputs: [
          { script: 'aa', satoshis: 400 },
          { script: 'bb', satoshis: 500 }
        ]
      }
    ],
    ['no outputs', { ...GOOD, outputs: [] }],
    ['a missing reference', { outputs: GOOD.outputs }],
    ['a numeric reference', { ...GOOD, reference: 5 }],
    ['an empty reference', { ...GOOD, reference: '' }],
    ['a body that is a string', 'nope']
  ]
  it.each(bad)('refuses %s', async (_name, body) => {
    const { client } = clientWith([destRule(async () => ok(body))])
    const r = await client.getP2pDestination('deggen@handcash.io', 1000)
    expect(r).toMatchObject({ kind: 'failed', reason: 'invalid_destination' })
  })

  it('refuses 11 whole-satoshi outputs that add up (output cap), but accepts 10', async () => {
    const mk = (n: number) => Array.from({ length: n }, () => ({ script: 'aa', satoshis: 1 }))
    const over = clientWith([destRule(async () => ok({ ...GOOD, outputs: mk(11) }))])
    expect(await over.client.getP2pDestination('deggen@handcash.io', 11)).toMatchObject({
      kind: 'failed',
      reason: 'invalid_destination'
    })
    const at = clientWith([destRule(async () => ok({ ...GOOD, outputs: mk(10) }))])
    expect((await at.client.getP2pDestination('deggen@handcash.io', 10)).kind).toBe('ok')
  })

  it('accepts several outputs that add up', async () => {
    const outputs = [
      { script: 'aa', satoshis: 400 },
      { script: 'bb', satoshis: 600 }
    ]
    const { client } = clientWith([destRule(async () => ok({ ...GOOD, outputs }))])
    const r = await client.getP2pDestination('deggen@handcash.io', 1000)
    expect(r.kind).toBe('ok')
  })

  it('a 2xx body that is not JSON gives invalid_destination', async () => {
    const { client } = clientWith([destRule(async () => textRes(200, '<html>'))])
    expect(await client.getP2pDestination('deggen@handcash.io', 1000)).toMatchObject({
      kind: 'failed',
      reason: 'invalid_destination'
    })
  })

  it("a 4xx or 5xx gives refused with the server's message", async () => {
    const { client } = clientWith([destRule(async () => notOk(404, { message: 'no such user' }))])
    expect(await client.getP2pDestination('deggen@handcash.io', 1000)).toEqual({
      kind: 'failed',
      reason: 'refused',
      message: 'no such user'
    })
    const b = clientWith([destRule(async () => notOk(500, {}))])
    expect(await b.client.getP2pDestination('deggen@handcash.io', 1000)).toMatchObject({
      reason: 'refused',
      message: 'HTTP 500'
    })
  })

  it('a 503 with a plain-text body gives refused / HTTP 503', async () => {
    const { client } = clientWith([destRule(async () => textRes(503, 'Service Unavailable'))])
    expect(await client.getP2pDestination('deggen@handcash.io', 1000)).toEqual({
      kind: 'failed',
      reason: 'refused',
      message: 'HTTP 503'
    })
  })

  it('accepts a 1-character alias and a plus tag', async () => {
    const { client, calls } = clientWith([destRule(async () => ok(GOOD))])
    expect((await client.getP2pDestination('a@handcash.io', 1000)).kind).toBe('ok')
    expect((await client.getP2pDestination('a+b@handcash.io', 1000)).kind).toBe('ok')
    expect(calls).toHaveLength(2)
  })

  it('rejects a 65-character alias', async () => {
    const { client, calls } = clientWith([destRule(async () => ok(GOOD))])
    for (const p of [`${'a'.repeat(65)}@handcash.io`]) {
      expect(await client.getP2pDestination(p, 1000)).toMatchObject({ kind: 'failed', reason: 'invalid_paymail' })
    }
    expect(calls).toHaveLength(0)
  })

  it('an invalid paymail (no @) gives invalid_paymail with no request', async () => {
    const { client, calls } = clientWith([])
    expect(await client.getP2pDestination('handcash.io', 1000)).toMatchObject({
      kind: 'failed',
      reason: 'invalid_paymail'
    })
    expect(calls).toHaveLength(0)
  })

  it('a destination template with a host placeholder gives unsupported', async () => {
    const d = okDiscovery({ '2a40af698840': 'https://{alias}.x.com/p/{domain.tld}' })
    const { client, calls } = clientWith([], d)
    expect(await client.getP2pDestination('deggen@handcash.io', 1000)).toMatchObject({
      kind: 'failed',
      reason: 'unsupported'
    })
    expect(calls).toHaveLength(0)
  })

  it('a throw gives unreachable', async () => {
    const { client } = clientWith([
      destRule(async () => {
        throw new Error('boom')
      })
    ])
    expect(await client.getP2pDestination('deggen@handcash.io', 1000)).toMatchObject({
      kind: 'failed',
      reason: 'unreachable'
    })
  })

  it('discovery failed gives unreachable; unsecured and none give unsupported; a missing pair gives unsupported', async () => {
    const run = async (d: CapabilityDiscovery) =>
      clientWith([], d).client.getP2pDestination('deggen@handcash.io', 1000)
    expect(await run({ kind: 'failed' })).toMatchObject({ reason: 'unreachable' })
    expect(await run({ kind: 'unsecured' })).toMatchObject({ reason: 'unsupported' })
    expect(await run({ kind: 'none' })).toMatchObject({ reason: 'unsupported' })
    expect(await run(okDiscovery({ '5c55a7fdb7bb': undefined }))).toMatchObject({ reason: 'unsupported' })
    expect(await run(okDiscovery({ '2a40af698840': undefined }))).toMatchObject({ reason: 'unsupported' })
  })
})

describe('postBeef', () => {
  const args = { endpoint: 'https://cloud.handcash.io/p2p/beef/deggen@handcash.io', beefHex: 'ab', reference: 'r' }

  it('sends {"beef","reference"} and nothing else', async () => {
    const { client, inits } = clientWith([['/p2p/beef/', async () => ok({ txid: TXID })]])
    await client.postBeef(args)
    expect(JSON.parse(String(inits[0]?.body))).toEqual({ beef: 'ab', reference: 'r' })
    expect(inits[0]?.method).toBe('POST')
  })

  it('accepted returns txid and note', async () => {
    const { client } = clientWith([['/p2p/beef/', async () => ok({ txid: TXID, note: 'thanks' })]])
    expect(await client.postBeef(args)).toEqual({ kind: 'accepted', txid: TXID, note: 'thanks' })
    const b = clientWith([['/p2p/beef/', async () => ok({ txid: TXID })]])
    expect(await b.client.postBeef(args)).toEqual({ kind: 'accepted', txid: TXID, note: '' })
  })

  it('a 2xx with a bad txid or a non-JSON body gives network / unreadable_receipt', async () => {
    for (const make of [async () => ok({ txid: 'zz' }), async () => ok({}), async () => textRes(200, 'ok')]) {
      const { client } = clientWith([['/p2p/beef/', make]])
      expect(await client.postBeef(args)).toEqual({ kind: 'network', message: 'unreadable_receipt' })
    }
  })

  it('a 503 gives http with status and message', async () => {
    const { client } = clientWith([['/p2p/beef/', async () => notOk(503, { message: 'parse error' })]])
    expect(await client.postBeef(args)).toEqual({ kind: 'http', status: 503, message: 'parse error' })
  })

  it('a 503 with a plain-text body gives http / HTTP 503, not network', async () => {
    const { client } = clientWith([['/p2p/beef/', async () => textRes(503, 'Service Unavailable')]])
    expect(await client.postBeef(args)).toEqual({ kind: 'http', status: 503, message: 'HTTP 503' })
  })

  it('a throw gives network', async () => {
    const { client } = clientWith([
      [
        '/p2p/beef/',
        async () => {
          throw new Error('offline')
        }
      ]
    ])
    expect(await client.postBeef(args)).toMatchObject({ kind: 'network' })
  })

  it('a private endpoint gives network / endpoint_not_public with no request', async () => {
    const { client, calls } = clientWith([])
    expect(await client.postBeef({ ...args, endpoint: 'https://127.0.0.1/x' })).toEqual({
      kind: 'network',
      message: 'endpoint_not_public'
    })
    expect(await client.postBeef({ ...args, endpoint: 'http://cloud.handcash.io/x' })).toEqual({
      kind: 'network',
      message: 'endpoint_not_public'
    })
    expect(calls).toHaveLength(0)
  })
})
