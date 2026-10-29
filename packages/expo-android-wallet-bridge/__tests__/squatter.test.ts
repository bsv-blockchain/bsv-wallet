jest.mock('expo-secure-store', () => require('../../expo-wallet-toolbox/__tests__/__mocks__/secureStoreFake').fake)

import { launchProof, helloMac } from '@bsv/expo-wallet-toolbox/core/bridge/loopback/launchProof'
import { getBindingRegistry } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { createHarness, type Harness } from './bridgeHarness'
import { CHALLENGE } from './controller/support'
import { PAGE_ORIGIN, createRelay, createSquatter, createWorld, secretsOfIntent, type World } from './loopbackSupport'
import { b64uDecode } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/base64url'

let h: Harness | undefined
let w: World | undefined
afterEach(() => {
  w?.dispose()
  h?.teardown()
  h = undefined
  w = undefined
})

async function setup(over: Parameters<typeof createWorld>[0] = {}) {
  h = await createHarness()
  w = createWorld({ ...over, deliverTo: h })
  const wallet = w.mountWallet(h, 3322)
  return { h, w, wallet }
}

describe('squatter and relay fixtures (blocker-level)', () => {
  it('squatter on 3321 with the real name, icon and vendor and no k: refused unauthenticated, not pinned, receives no epoch, launch proof or token (fixture records every byte and the test asserts none appears), real wallet on 3322 is connected', async () => {
    const { w: world } = await setup()
    const squatter = await createSquatter('127.0.0.1:3321')
    world.http.mount('127.0.0.1:3321', squatter.handler)
    // A token the page holds for the squatter's own key: it must never be sent to it.
    world.tokenStore.setItem(`brc185-android-pin:${PAGE_ORIGIN}`, squatter.identity.continuityKey)
    world.tokenStore.setItem(
      `brc185-android-token:${PAGE_ORIGIN}:${squatter.identity.continuityKey}`,
      'squatter-token-123'
    )
    world.tokenStore.data.delete(`brc185-android-pin:${PAGE_ORIGIN}`) // first visit: nothing pinned

    const client = world.client()
    const { epoch } = client.launch()
    const { k, n } = secretsOfIntent(world.hrefs[0])
    const { providers, rejected } = await client.discover()

    expect(rejected.map(r => r.reason)).toContain('unauthenticated')
    expect(providers).toHaveLength(1)
    expect((providers[0].handle as { host: string }).host).toBe('127.0.0.1:3322')
    expect(providers[0].descriptor.continuityKey).not.toBe(squatter.identity.continuityKey)
    expect(world.tokenStore.getItem(`brc185-android-pin:${PAGE_ORIGIN}`)).toBeNull()

    const conn = await client.connect(providers[0])
    expect(await client.invoke(conn, 'getVersion')).toBeDefined()
    const pinned = world.tokenStore.getItem(`brc185-android-pin:${PAGE_ORIGIN}`)
    expect(pinned).toBe(providers[0].descriptor.continuityKey)
    expect(pinned).not.toBe(squatter.identity.continuityKey)

    // Everything the squatter ever received is describe GETs: no secret, no proof, no token, no binding header.
    expect(squatter.requests.length).toBeGreaterThan(0)
    for (const r of squatter.requests) {
      expect(r.method).toBe('GET')
      expect(r.target.startsWith('/.well-known/brc-wallet?challenge=')).toBe(true)
      expect(r.body).toBe('')
      expect(Object.keys(r.headers).filter(x => x.startsWith('brc-185'))).toEqual([])
    }
    const everything = squatter.seen.join('\n')
    for (const secret of [epoch, k, n, 'squatter-token-123']) expect(everything).not.toContain(secret)
    expect(everything).not.toContain('launchProof')
    expect(everything).not.toContain('reconnectToken')
  })

  it('a squatter that never answers its describe does not delay the real wallet', async () => {
    const { w: world } = await setup()
    const hanging = await createSquatter('127.0.0.1:3321', { hang: true })
    world.http.mount('127.0.0.1:3321', hanging.handler)
    const client = world.client({ attemptTimeoutMs: 5000, totalMs: 15000 })
    client.launch()
    const started = Date.now()
    const { providers } = await client.discover()
    expect((providers[0].handle as { host: string }).host).toBe('127.0.0.1:3322')
    // Far below the 5 s attempt deadline: the connect goes only to the authenticated endpoint.
    expect(Date.now() - started).toBeLessThan(2000)
    const conn = await client.connect(providers[0])
    expect(conn.epoch).toBeDefined()
    expect(hanging.requests.every(r => r.method === 'GET')).toBe(true)
  })

  it('relay fixture forwarding 3321 to 3322 fails hello and proof because host is bound', async () => {
    const { w: world, wallet } = await setup()
    const relay = createRelay(wallet.handler, '127.0.0.1:3322')
    world.http.mount('127.0.0.1:3321', relay.handler)

    const client = world.client()
    client.launch()
    const { providers, rejected } = await client.discover()
    // Through the relay the descriptor names 3322, not the endpoint that answered: refused. The direct one is found.
    expect(rejected.some(r => r.reason.includes('does not advertise'))).toBe(true)
    expect((providers[0].handle as { host: string }).host).toBe('127.0.0.1:3322')

    // Even a page that skipped the responder check gets no acknowledgement through the relay (host is in the hello MAC)...
    const { k, n, epoch } = secretsOfIntent(world.hrefs[0])
    const kBytes = b64uDecode(k)
    const hello = helloMac(kBytes, { origin: PAGE_ORIGIN, challenge: CHALLENGE, host: '127.0.0.1:3321' })
    const viaRelay = await world.http.fetch(
      `http://127.0.0.1:3321/.well-known/brc-wallet?challenge=${CHALLENGE}&hello=${hello}`
    )
    expect(viaRelay.status).toBe(200)
    expect(viaRelay.headers.get('BRC-185-Android-Ack')).toBeNull()

    // ...and a launch proof made for the relay's host fails at the wallet, which burns the record.
    const wallet3322 = JSON.parse(
      await (await world.http.fetch(`http://127.0.0.1:3322/.well-known/brc-wallet?challenge=${CHALLENGE}`)).text()
    ).descriptor
    const identity = { instanceId: wallet3322.instanceId, continuityKey: wallet3322.continuityKey }
    const message = {
      wallet: identity,
      epoch,
      origin: PAGE_ORIGIN,
      challenge: CHALLENGE,
      host: '127.0.0.1:3321',
      nonce: n
    }
    const proof = launchProof(kBytes, message)
    const connectRes = await world.http.fetch('http://127.0.0.1:3321/.well-known/brc-wallet/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ epoch, challenge: CHALLENGE, ...identity, android: { launchProof: proof } })
    })
    expect(connectRes.status).toBe(403)
    expect(getBindingRegistry().live()).toHaveLength(0)
  })

  it('a relay that forwards Host unchanged is refused by the wallet and invisible to the page', async () => {
    const { w: world, wallet } = await setup()
    const relay = createRelay(wallet.handler, '127.0.0.1:3322', { rewriteHost: false })
    world.http.mount('127.0.0.1:3321', relay.handler)
    await expect(
      world.http.fetch('http://127.0.0.1:3321/.well-known/brc-wallet?challenge=' + CHALLENGE)
    ).rejects.toThrow()
  })
})
