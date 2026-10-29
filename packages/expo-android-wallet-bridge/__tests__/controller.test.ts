jest.mock('expo-secure-store', () => require('../../expo-wallet-toolbox/__tests__/__mocks__/secureStoreFake').fake)

import { WERR_INVALID_PARAMETER } from '@bsv/sdk'
import { attachBridgeHost, getBindingRegistry, onBindingClosed } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { hasUnattestedTransport } from '@bsv/expo-wallet-toolbox/core/bridge/runtimeFlags'
import type { CloseEvent } from '@bsv/expo-wallet-toolbox/core/bridge/bindings'
import { BRIDGE_METHODS } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/methods'
import { launchProof } from '@bsv/expo-wallet-toolbox/core/bridge/loopback/launchProof'
import { CHALLENGE, epochOf, flush, kOf, nOf } from './controller/support'
import { GOLDEN, HOST, ORIGIN, bodyOf, createHarness, headerOf, type Harness } from './bridgeHarness'

let h: Harness | undefined
const mk = async (...a: Parameters<typeof createHarness>) => (h = await createHarness(...a))
afterEach(() => {
  h?.teardown()
  h = undefined
})

const liveEpochs = () =>
  getBindingRegistry()
    .live()
    .map(b => b.epoch)

/** Connects, parks the first call on the consent sheet and approves it. */
async function consented(t: Harness, i = 1, origin = ORIGIN) {
  const c = await t.connect(i, { origin })
  expect(c.response.status).toBe(200)
  t.sendRpc(c, 'getHeight', {}, `first-${i}`, origin)
  await t.approve()
  await t.waitFor(() => t.response(`first-${i}`) !== undefined, 'the approved first call')
  return c
}

describe('controller over the real core', () => {
  it('all 28 methods round-trip over the controller', async () => {
    const t = await mk()
    const c = await consented(t)
    const methods = Object.keys(BRIDGE_METHODS)
    expect(methods).toHaveLength(28)
    for (const m of methods) {
      const probe = BRIDGE_METHODS[m as keyof typeof BRIDGE_METHODS].probe
      const r = await t.rpc(c, m, probe ? {} : GOLDEN[m].args)
      expect(`${m} ${r.status}`).toBe(`${m} 200`)
      if (!probe) expect(bodyOf(r)).toEqual(GOLDEN[m].result)
    }
    // Calls reach the unverified manager only.
    expect(t.unverified.wallet.createAction).toHaveBeenCalledTimes(1)
    expect(t.attested.wallet.createAction).not.toHaveBeenCalled()
  })

  it('wallet error is 400 WireError', async () => {
    const t = await mk()
    const c = await consented(t)
    t.unverified.wallet.getHeight.mockRejectedValueOnce(new WERR_INVALID_PARAMETER('x', 'valid'))
    const r = await t.rpc(c, 'getHeight', {})
    expect(r.status).toBe(400)
    expect(bodyOf(r)).toMatchObject({ code: 6 })
  })

  it('unknown delivery on a response over 5 MiB', async () => {
    const t = await mk()
    const c = await consented(t)
    t.unverified.wallet.createAction.mockResolvedValueOnce({ tx: new Array(3_000_000).fill(255) })
    const r = await t.rpc(c, 'createAction', GOLDEN.createAction.args)
    expect(r.status).toBe(502)
    expect(bodyOf(r)).toMatchObject({ code: 'RESOURCE_LIMIT', delivery: 'unknown' })
  })

  it('cold start: hostAttached false parks the connect, attach with a wallet resumes, attach with none answers 503', async () => {
    // Attach with a wallet.
    const t = await mk({ cold: true })
    const parked = connectInBackground(t, 1)
    await t.waitFor(() => t.bridge.session.parkedCount() === 1, 'parked connects')
    const detach = attachBridgeHost({ withdrawPrompts: jest.fn(), hasWallet: true })
    await t.waitFor(() => t.bridge.session.parkedCount() === 1, 'parked connects') // building: still parked
    t.publishAll('ready')
    expect((await parked).status).toBe(200)
    detach()
    t.teardown()

    // Attach with no wallet.
    const u = await mk({ cold: true })
    const parked2 = connectInBackground(u, 1)
    await u.waitFor(() => u.bridge.session.parkedCount() === 1, 'a parked connect')
    const detach2 = attachBridgeHost({ withdrawPrompts: jest.fn() })
    const r = await parked2
    detach2()
    expect(r.status).toBe(503)
    expect(bodyOf(r)).toMatchObject({ code: 'CONFIGURATION_ERROR', delivery: 'not-sent' })
  })

  it('connect while building parks and resumes on ready', async () => {
    const t = await mk({ cold: true })
    const detach = attachBridgeHost({ withdrawPrompts: jest.fn(), hasWallet: true })
    const parked = connectInBackground(t, 1)
    await t.waitFor(() => t.bridge.session.parkedCount() === 1, 'parked connects')
    t.publishAll('ready')
    expect((await parked).status).toBe(200)
    expect(liveEpochs()).toHaveLength(1)
    detach()
  })

  it('client gone before consent: the sheet is withdrawn, the wallet is never called and nothing is written', async () => {
    const t = await mk()
    const c = await t.connect(1)
    t.sendRpc(c, 'createAction', GOLDEN.createAction.args, 'gone-1')
    await t.waitFor(() => t.consent.listPending().length === 1, 'the consent request')
    t.native.emitGone('gone-1')
    await t.waitFor(() => t.consent.listPending().length === 0, 'the consent request withdrawn')
    await flush()
    expect(t.unverified.wallet.createAction).not.toHaveBeenCalled()
    expect(t.response('gone-1')).toBeUndefined()
    expect(liveEpochs()).toEqual([])
  })

  it('client gone before the wallet call rejects CONNECTION_CLOSED not-sent', async () => {
    const t = await mk()
    const c = await consented(t)
    // The wallet stops being ready, so the next call waits; the page leaves; the wallet returns.
    t.publishAll('building')
    t.sendRpc(c, 'getHeight', {}, 'late-1')
    await flush()
    t.native.emitGone('late-1')
    t.unverified.wallet.getHeight.mockClear()
    t.publishAll('ready')
    await t.waitFor(() => t.outcomes.length > 1, 'the outcome')
    const o = t.outcomes[t.outcomes.length - 1] as any
    expect(o.connectionError).toMatchObject({ code: 'CONNECTION_CLOSED', delivery: 'not-sent' })
    expect(t.unverified.wallet.getHeight).not.toHaveBeenCalled()
  })

  it('two parked connects released together yield one binding', async () => {
    const t = await mk({ cold: true })
    const detach = attachBridgeHost({ withdrawPrompts: jest.fn(), hasWallet: true })
    const a = connectInBackground(t, 1)
    const b = connectInBackground(t, 2)
    await t.waitFor(() => t.bridge.session.parkedCount() === 2, 'parked connects')
    t.publishAll('ready')
    const [ra, rb] = await Promise.all([a, b])
    expect([ra.status, rb.status].sort()).toEqual([200, 429])
    expect(liveEpochs()).toHaveLength(1)
    detach()
  })

  it('logout reset closes bindings lost and rotates identities', async () => {
    const t = await mk()
    const c = await t.connect(1)
    const before = c.wallet
    const closed: CloseEvent[] = []
    const off = onBindingClosed(e => closed.push(e))
    await t.bridge.reset()
    off()
    expect(closed.map(e => [e.epoch, e.reason])).toEqual([[c.epoch, 'lost']])
    expect(liveEpochs()).toEqual([])
    expect(t.bridge.session.state()).toBe('IDLE')
    const after = await t.bridge.continuity.getOrCreate(`android:${ORIGIN}`)
    expect(after.instanceId).not.toBe(before.instanceId)
    expect(after.continuityKey).not.toBe(before.continuityKey)
  })

  it("reset(ctx) through the continuity onReset hook closes only that origin's bindings lost", async () => {
    const t = await mk()
    const a = await t.connect(1, { origin: 'https://a.example' })
    const b = await t.connect(2, { origin: 'https://b.example' })
    expect(liveEpochs().sort()).toEqual([a.epoch, b.epoch].sort())
    const closed: CloseEvent[] = []
    const off = onBindingClosed(e => closed.push(e))
    await t.bridge.continuity.reset('android:https://a.example')
    off()
    expect(closed.map(e => [e.epoch, e.reason])).toEqual([[a.epoch, 'lost']])
    expect(liveEpochs()).toEqual([b.epoch])
  })

  it('server stop closes all lost', async () => {
    const t = await mk()
    const a = await t.connect(1, { origin: 'https://a.example' })
    const b = await t.connect(2, { origin: 'https://b.example' })
    const closed: CloseEvent[] = []
    const off = onBindingClosed(e => closed.push(e))
    t.native.emitServerStopped('error')
    await flush()
    off()
    expect(closed.map(e => e.epoch).sort()).toEqual([a.epoch, b.epoch].sort())
    expect(closed.every(e => e.reason === 'lost')).toBe(true)
    expect(liveEpochs()).toEqual([])
  })

  it('user-disconnect closes every binding lost and returns the session to IDLE', async () => {
    const t = await mk()
    const c = await t.connect(1)
    expect(t.bridge.session.state()).toBe('ACTIVE')
    const closed: CloseEvent[] = []
    const off = onBindingClosed(e => closed.push(e))
    t.native.emitServerStopped('user-disconnect')
    await flush()
    off()
    expect(closed.map(e => [e.epoch, e.reason])).toEqual([[c.epoch, 'lost']])
    expect(t.bridge.session.state()).toBe('IDLE')
    expect(t.native.serverRunning).toBe(false)
  })

  it('token never reaches a non-owner binding, and goes once to the owner', async () => {
    const t = await mk()
    const c = await t.connect(1)
    // A binding that is not the unsettled owner gets nothing, whatever the core does.
    t.bridge.controller.transport.deliverReconnectToken(
      { epoch: 'not-the-owner', applicationOrigin: ORIGIN } as any,
      'stolen-token'
    )
    t.sendRpc(c, 'getHeight', {}, 'tok-1')
    await t.approve()
    await t.waitFor(() => t.response('tok-1') !== undefined, 'the first response')
    const first = t.response('tok-1')!
    const token = headerOf(first, 'BRC-185-Reconnect-Token')
    expect(token).toBeDefined()
    expect(token).not.toBe('stolen-token')
    // Written once: the next response carries none.
    const second = await t.rpc(c, 'getHeight', {})
    expect(headerOf(second, 'BRC-185-Reconnect-Token')).toBeUndefined()
    // Approval settled the binding, so the origin may connect again.
    const again = await t.connect(2)
    expect(again.response.status).toBe(200)
  })

  it('a write that fails keeps the token for the next response', async () => {
    const t = await mk()
    const c = await t.connect(1)
    const respond = t.native.respond.bind(t.native)
    let failNext = true
    t.native.respond = async (id, status, headers, body) => {
      if (failNext && id === 'tok-2') {
        failNext = false
        return false
      }
      return respond(id, status, headers, body)
    }
    t.sendRpc(c, 'getHeight', {}, 'tok-2')
    await t.approve()
    await t.waitFor(() => !failNext, 'the failed write')
    await flush()
    expect(t.response('tok-2')).toBeUndefined()
    // The token stayed in the outbox: the next response carries it, then it is gone.
    const next = await t.rpc(c, 'getHeight', {})
    expect(headerOf(next, 'BRC-185-Reconnect-Token')).toBeDefined()
    expect(headerOf(await t.rpc(c, 'getHeight', {}), 'BRC-185-Reconnect-Token')).toBeUndefined()
  })

  it('registration-order test: the unverified manager exists when the transport is registered at module scope and is missing when registered after the build', async () => {
    // The wallet build (WalletContext) creates the unverified manager only while an unattested transport is present.
    const build = () => ({ unverified: hasUnattestedTransport() })
    const builtBefore = build() // a build that ran before the kit registered
    expect(builtBefore).toEqual({ unverified: false })
    const t = await mk()
    expect(t.bridge.transport.attestation).toBe('unattested')
    const builtAfter = build() // a build that runs after the module-scope registration
    expect(builtAfter).toEqual({ unverified: true })
  })
})

function connectInBackground(t: Harness, i: number) {
  return (async () => {
    await t.launch(i)
    const id = `cb${i}`
    // Identity first (a describe parks nothing), then the connect that does.
    const wallet = await t.describe(ORIGIN)
    const epoch = epochOf(i)
    const proof = launchProof(kOf(i), {
      wallet,
      epoch,
      origin: ORIGIN,
      challenge: CHALLENGE,
      host: HOST,
      nonce: nOf(i)
    })
    return t.request({
      id,
      method: 'POST',
      target: '/.well-known/brc-wallet/connect',
      headers: [
        ['host', HOST],
        ['origin', ORIGIN],
        ['content-type', 'application/json']
      ],
      body: JSON.stringify({ epoch, challenge: CHALLENGE, ...wallet, android: { launchProof: proof } })
    })
  })()
}
