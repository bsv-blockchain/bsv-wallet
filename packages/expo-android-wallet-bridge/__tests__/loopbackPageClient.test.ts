jest.mock('expo-secure-store', () => require('../../expo-wallet-toolbox/__tests__/__mocks__/secureStoreFake').fake)

import { getBindingRegistry } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { GOLDEN, createHarness, type Harness } from './bridgeHarness'
import { PAGE_ORIGIN, corsFor, createWorld, type World } from './loopbackSupport'
import type { MemoryHandler } from '../src/testing/inMemoryHttp'
import type { Connection, LoopbackPageClient } from '../src/testing/loopbackPageClient'

let h: Harness | undefined
let w: World | undefined
afterEach(() => {
  w?.dispose()
  h?.teardown()
  h = undefined
  w = undefined
})

async function setup(port = 3321, over: Parameters<typeof createWorld>[0] = {}) {
  h = await createHarness()
  w = createWorld({ ...over, deliverTo: h })
  const wallet = w.mountWallet(h, port)
  return { h, w, wallet }
}

async function open(client: LoopbackPageClient): Promise<Connection> {
  client.launch()
  const { providers } = await client.discover()
  expect(providers).toHaveLength(1)
  return client.connect(providers[0])
}

/** The first call of a binding parks on the consent sheet; approve it so the binding settles. */
async function settle(t: Harness, client: LoopbackPageClient, conn: Connection) {
  const first = client.invoke(conn, 'getPublicKey', GOLDEN.getPublicKey.args)
  await t.approve()
  expect(await first).toEqual(GOLDEN.getPublicKey.result)
}

describe('loopback page client against the real controller', () => {
  it('happy path describe, connect, getVersion, getPublicKey, disconnect', async () => {
    const { h: t, w: world } = await setup()
    const client = world.client()
    expect(world.hrefs).toHaveLength(0)
    const conn = await open(client)
    expect(world.hrefs).toHaveLength(1)
    expect(world.hrefs[0]).toMatch(
      /^intent:\/\/launch\?v=1&e=[0-9a-f-]{36}&k=[\w-]{43}&n=[\w-]{22}#Intent;scheme=bsv-wallet-bridge;package=org\.bsvblockchain\.wallet;end$/
    )
    expect(conn.epoch).toMatch(/^[0-9a-f-]{36}$/)
    expect(conn.provider.descriptor.name).toBe('Test Wallet')

    expect(await client.invoke(conn, 'getVersion')).toEqual(expect.objectContaining({ version: expect.any(String) }))
    await settle(t, client, conn)
    // The pin is set only after the acknowledgement verified.
    expect(world.tokenStore.getItem(`brc185-android-pin:${PAGE_ORIGIN}`)).toBe(conn.provider.descriptor.continuityKey)

    expect(
      getBindingRegistry()
        .live()
        .map(b => b.epoch)
    ).toEqual([conn.epoch])
    await conn.disconnect()
    expect(getBindingRegistry().live()).toHaveLength(0)
    // A closed connection makes no further request.
    const before = world.http.log.length
    await expect(client.invoke(conn, 'getVersion')).rejects.toMatchObject({
      code: 'CONNECTION_CLOSED',
      delivery: 'not-sent'
    })
    expect(world.http.log).toHaveLength(before)
  })

  it('stops scanning at the first authenticated endpoint', async () => {
    const { w: world } = await setup(3323)
    const client = world.client({ parallel: 1, window: 64 })
    client.launch()
    const { providers, rejected } = await client.discover()
    expect(providers).toHaveLength(1)
    expect(rejected).toEqual([])
    const ports = world.urls.map(u => Number(new URL(u).port))
    // 3321 and 3322 were absent, 3323 answered; nothing beyond it was asked.
    expect(Math.max(...ports)).toBe(3323)
    expect(ports.filter(p => p === 3323)).toHaveLength(1)
  })

  it('captured connect replayed to the real wallet is refused by the burnt record', async () => {
    const { h: t, w: world, wallet } = await setup()
    const client = world.client()
    const conn = await open(client)
    await settle(t, client, conn)
    const captured = world.http.log.find(
      r => r.method === 'POST' && r.target === '/.well-known/brc-wallet/connect' && !r.preflight
    )!
    expect(captured).toBeDefined()
    const replay = await wallet.handler({ ...captured })
    expect(replay.status).toBe(403)
    expect(JSON.parse(replay.body)).toMatchObject({ code: 'CONFIGURATION_ERROR', message: 'launch proof required' })
    expect(getBindingRegistry().live()).toHaveLength(1)
  })

  it('token is stored only after ack verification and sent only to a key-matched ack-verified endpoint', async () => {
    const { h: t, w: world } = await setup()
    const client = world.client()

    // (a) a connect whose acknowledgement does not verify pins nothing, stores nothing, and makes no RPC.
    const originalFetch = world.opts.fetch
    const corrupting = world.client({
      fetch: async (url, init) => {
        const res = await originalFetch(url, init)
        if (!url.endsWith('/connect') || init?.method !== 'POST') return res
        return { ...res, headers: { get: (n: string) => (n === 'BRC-185-Android-Ack' ? 'AAAA' : res.headers.get(n)) } }
      }
    })
    corrupting.launch()
    const first = await corrupting.discover()
    await expect(corrupting.connect(first.providers[0])).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(world.tokenStore.data.size).toBe(0)
    expect(world.urls.some(u => u.includes('/brc185/v1/rpc/'))).toBe(false)
    // That binding exists on the wallet but is unsettled: close it so the origin may connect again.
    for (const b of getBindingRegistry().live()) getBindingRegistry().close(b.epoch, 'disconnected')

    // (b) a good connect: the token arrives on the first RPC response and is stored under the pinned key.
    const conn = await open(client)
    await settle(t, client, conn)
    const key = conn.provider.descriptor.continuityKey
    const stored = world.tokenStore.getItem(`brc185-android-token:${PAGE_ORIGIN}:${key}`)
    expect(stored).toBeTruthy()

    // (c) the next connect offers it, to this key-matched endpoint only.
    const second = await open(client)
    const posts = world.http.log.filter(
      r => r.method === 'POST' && r.target === '/.well-known/brc-wallet/connect' && !r.preflight
    )
    const lastBody = JSON.parse(posts[posts.length - 1].body)
    expect(lastBody.android.reconnectToken).toBe(stored)
    expect(second.epoch).not.toBe(conn.epoch)
  })

  it('a stored token is not offered when the pinned key differs from the endpoint key', async () => {
    const { w: world } = await setup()
    const client = world.client()
    world.tokenStore.setItem(`brc185-android-pin:${PAGE_ORIGIN}`, 'a-different-key')
    client.launch()
    const { providers } = await client.discover()
    const key = providers[0].descriptor.continuityKey
    world.tokenStore.setItem(`brc185-android-token:${PAGE_ORIGIN}:${key}`, 'stale-token')
    await client.connect(providers[0])
    const post = world.http.log.find(
      r => r.method === 'POST' && r.target === '/.well-known/brc-wallet/connect' && !r.preflight
    )!
    expect(JSON.parse(post.body).android).not.toHaveProperty('reconnectToken')
    expect(post.body).not.toContain('stale-token')
  })

  it('429 on connect surfaces Retry-After and offers a new click', async () => {
    const { h: t, w: world } = await setup()
    const client = world.client()
    await open(client) // unsettled: a second connect for the origin gets 429
    client.launch()
    const { providers } = await client.discover()
    const err: any = await client.connect(providers[0]).catch(e => e)
    expect(err).toMatchObject({ code: 'RESOURCE_LIMIT', delivery: 'not-sent', newClick: true })
    // The router does not CORS-expose Retry-After, so the page falls back to the documented 5 s.
    expect(err.retryAfterMs).toBe(5000)
    expect(t.native.serverRunning).toBe(true)
  })

  it('reads Retry-After when the response exposes it', async () => {
    const { w: world, wallet } = await setup()
    world.http.mount('127.0.0.1:3321', async req => {
      const r = await wallet.handler(req)
      if (r.status !== 429) return r
      return {
        ...r,
        headers: [
          ...r.headers.filter(([k]) => k !== 'Access-Control-Expose-Headers' && k !== 'Retry-After'),
          ['Access-Control-Expose-Headers', 'BRC-185-Android-Ack, Retry-After'],
          ['Retry-After', '7']
        ]
      }
    })
    const client = world.client()
    await open(client)
    client.launch()
    const { providers } = await client.discover()
    const err: any = await client.connect(providers[0]).catch(e => e)
    expect(err.retryAfterMs).toBe(7000)
  })

  it('412 on RPC means reconnect from launch, never replay', async () => {
    const { h: t, w: world, wallet } = await setup()
    const client = world.client()
    const conn = await open(client)
    await settle(t, client, conn)

    // A readable 412: the call is not replayed and the connection is dead.
    let hits = 0
    world.http.mount('127.0.0.1:3321', async req => {
      if (req.target === '/brc185/v1/rpc/getHeight' && !req.preflight) {
        hits++
        return {
          status: 412,
          headers: [
            ...corsFor(PAGE_ORIGIN),
            ['Access-Control-Expose-Headers', 'BRC-185-Reconnect-Token'],
            ['Content-Type', 'application/json']
          ],
          body: JSON.stringify({
            domain: 'brc185',
            code: 'PROVIDER_CHANGED',
            message: 'Unknown connection',
            delivery: 'not-sent'
          })
        }
      }
      return wallet.handler(req)
    })
    const err: any = await client.invoke(conn, 'getHeight', {}).catch(e => e)
    expect(err).toMatchObject({ code: 'PROVIDER_CHANGED', newClick: true })
    await expect(client.invoke(conn, 'getHeight', {})).rejects.toMatchObject({
      code: 'CONNECTION_CLOSED',
      delivery: 'not-sent'
    })
    expect(hits).toBe(1)
  })

  it('a binding the wallet retired shows as one failed call and is never replayed', async () => {
    const { h: t, w: world } = await setup()
    const client = world.client()
    const conn = await open(client)
    await settle(t, client, conn)
    getBindingRegistry().close(conn.epoch, 'revoked')
    const before = world.http.log.filter(r => r.target.includes('/rpc/')).length
    // The router refuses a retired binding with no CORS, so the page sees a failed fetch: sent, outcome unknown.
    await expect(client.invoke(conn, 'getVersion')).rejects.toMatchObject({
      code: 'CONNECTION_CLOSED',
      delivery: 'unknown'
    })
    await expect(client.invoke(conn, 'getVersion')).rejects.toMatchObject({ delivery: 'not-sent' })
    const rpcs = world.http.log.filter(r => r.target.includes('/rpc/') && !r.preflight)
    expect(rpcs.length - before).toBeLessThanOrEqual(1)
  })

  it('no legacy route is ever requested', async () => {
    const { h: t, w: world } = await setup()
    const client = world.client()
    const conn = await open(client)
    await settle(t, client, conn)
    await conn.disconnect()
    const allowed = /^\/(\.well-known\/brc-wallet(\/connect(\/[0-9a-f-]{36})?)?(\?.*)?|brc185\/v1\/rpc\/[A-Za-z0-9]+)$/
    expect(world.urls.length).toBeGreaterThan(0)
    for (const u of world.urls) {
      const url = new URL(u)
      expect(url.hostname).toBe('127.0.0.1')
      expect(Number(url.port)).toBeGreaterThanOrEqual(3321)
      expect(Number(url.port)).toBeLessThanOrEqual(3384)
      expect(url.pathname + url.search).toMatch(allowed)
    }
    expect(world.urls.some(u => /:(3301|2121)\b/.test(u))).toBe(false)
  })
})

describe('permission and rediscovery', () => {
  it('permission names tried in order', async () => {
    const names: string[] = []
    const world = createWorld({
      permissions: async name => {
        names.push(name)
        if (name === 'loopback-network') throw new TypeError('unknown permission')
        return { state: 'prompt' }
      }
    })
    expect(await world.client().permission()).toBe('prompt')
    expect(names).toEqual(['loopback-network', 'local-network-access'])

    names.length = 0
    const first = createWorld({
      permissions: async name => {
        names.push(name)
        return { state: 'granted' }
      }
    })
    expect(await first.client().permission()).toBe('granted')
    expect(names).toEqual(['loopback-network'])

    const neither = createWorld({
      permissions: async () => {
        throw new TypeError('unknown permission')
      }
    })
    expect(await neither.client().permission()).toBe('unsupported')
    expect(await createWorld().client().permission()).toBe('unsupported')
    expect(await createWorld({ origin: 'http://localhost:3000' }).client().permission()).toBe('exempt')
  })

  it('a denied permission is reported blocked and probes nothing', async () => {
    const world = createWorld({ permissions: async () => ({ state: 'denied' }) })
    const client = world.client()
    client.launch()
    const r = await client.discover()
    expect(r.providers).toEqual([])
    expect(r.rejected.map(x => x.reason)).toEqual(['blocked'])
    expect(world.urls).toEqual([])
  })

  it('elicit makes exactly one request and swallows the failure', async () => {
    const world = createWorld()
    await world.client().elicit()
    expect(world.urls).toHaveLength(1)
    expect(world.urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:3321\/\.well-known\/brc-wallet\?challenge=[\w-]{43}$/)
  })

  it('wallet did not open after 15 s', async () => {
    const world = createWorld({ fast: true })
    const client = world.client()
    client.launch()
    const started = Date.now()
    const r = await client.discover()
    expect(r.providers).toEqual([])
    expect(r.rejected.map(x => x.reason)).toEqual(['wallet did not open'])
    // The (scaled) 120 ms budget, not a background loop.
    expect(Date.now() - started).toBeGreaterThanOrEqual(80)
    const settled = world.urls.length
    await new Promise(res => setTimeout(res, 60))
    expect(world.urls).toHaveLength(settled)
  })

  it('discover without a click is refused', async () => {
    await expect(createWorld().client().discover()).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' })
  })
})
