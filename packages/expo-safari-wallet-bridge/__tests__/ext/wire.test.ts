/** @jest-environment node */
import { isConnectionError } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/connectionError'
import { BRIDGE_METHODS } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/methods'
import { connectedHash } from '../../shared/mirror'
import { createWorld, tick, until, type Frame, type World } from './chain'
import { makeMirror } from './fakeBrowser'
import { utf8Bytes } from '../../extension/src/lib/bytes'

const ORIGIN = 'https://app.example'
let world: World

afterEach(() => {
  world?.dispose()
})

/** Discovers and connects through the real page-world, content and background code. */
async function connected(frame: Frame) {
  const { providers } = await frame.client.discover()
  expect(providers).toHaveLength(1)
  const conn = await frame.client.connect(providers[0])
  return conn
}

const lastRecord = (w: World) => {
  const all = [...w.appex.records.entries()]
  const [id, rec] = all[all.length - 1]
  return { id, json: JSON.parse(Buffer.from(rec.bytes).toString('utf8')) as any }
}

const answer = (w: World, recordId: string, result: unknown) =>
  w.appex.resultBytes.set(recordId, utf8Bytes(JSON.stringify({ v: 1, id: recordId, ok: true, result })))

describe('BRC-185 page wire', () => {
  it('event names and detail shapes', async () => {
    world = createWorld()
    const f = world.newFrame()
    const seen: any[] = []
    f.win.addEventListener('brc185:announce-provider', e => seen.push(e.detail))
    const requestId = '11111111-1111-4111-8111-aaaaaaaaaaaa'
    f.win.dispatchEvent(new CustomEvent('brc185:request-provider', { detail: { version: 1, requestId } }))
    expect(seen).toHaveLength(1)
    expect(Object.keys(seen[0]).sort()).toEqual(['handle', 'requestId', 'version'])
    expect(seen[0]).toMatchObject({ version: 1, requestId })
  })

  it('answers once per requestId', async () => {
    world = createWorld()
    const f = world.newFrame()
    const seen: any[] = []
    f.win.addEventListener('brc185:announce-provider', e => seen.push(e.detail))
    const detail = { version: 1, requestId: '11111111-1111-4111-8111-aaaaaaaaaaaa' }
    for (let i = 0; i < 3; i++) f.win.dispatchEvent(new CustomEvent('brc185:request-provider', { detail }))
    expect(seen).toHaveLength(1)
    f.win.dispatchEvent(
      new CustomEvent('brc185:request-provider', {
        detail: { version: 1, requestId: '11111111-1111-4111-8111-bbbbbbbbbbbb' }
      })
    )
    expect(seen).toHaveLength(2)
    // malformed requests get no answer
    f.win.dispatchEvent(
      new CustomEvent('brc185:request-provider', { detail: { version: 2, requestId: detail.requestId } })
    )
    f.win.dispatchEvent(new CustomEvent('brc185:request-provider', { detail: { version: 1, requestId: 'nope' } }))
    expect(seen).toHaveLength(2)
  })

  it('no unsolicited announce, and window.CWI is never touched', async () => {
    world = createWorld()
    const f = world.newFrame()
    const seen: unknown[] = []
    f.win.addEventListener('brc185:announce-provider', e => seen.push(e))
    await tick(30)
    expect(seen).toHaveLength(0)
    expect('CWI' in f.win).toBe(false)
  })

  it('opaque, about:blank and srcdoc frames do not announce', async () => {
    world = createWorld()
    for (const f of [
      world.newFrame({ tabId: 2, url: 'about:blank' }),
      world.newFrame({ tabId: 3, url: 'about:srcdoc' }),
      world.newFrame({ tabId: 4, url: 'https://sandboxed.example/', opaque: true })
    ]) {
      const seen: unknown[] = []
      f.win.addEventListener('brc185:announce-provider', e => seen.push(e))
      f.win.dispatchEvent(
        new CustomEvent('brc185:request-provider', {
          detail: { version: 1, requestId: '11111111-1111-4111-8111-aaaaaaaaaaaa' }
        })
      )
      expect(seen).toHaveLength(0)
    }
  })

  it('handle is frozen and has exactly describe, connect, disconnect', async () => {
    world = createWorld()
    const f = world.newFrame()
    const [handle] = await new Promise<any[]>(resolve => {
      f.win.addEventListener('brc185:announce-provider', e => resolve([e.detail.handle]))
      f.win.dispatchEvent(
        new CustomEvent('brc185:request-provider', {
          detail: { version: 1, requestId: '11111111-1111-4111-8111-aaaaaaaaaaaa' }
        })
      )
    })
    expect(Object.isFrozen(handle)).toBe(true)
    expect(Object.keys(handle).sort()).toEqual(['connect', 'describe', 'disconnect'])
    expect(() => {
      'use strict'
      handle.extra = 1
    }).toThrow()
  })

  it('answers with the mirror absent: describe works, connect is CONFIGURATION_ERROR not-sent', async () => {
    world = createWorld({ mirrorState: 'absent' })
    const f = world.newFrame()
    const { providers } = await f.client.discover()
    expect(providers).toHaveLength(1)
    expect(providers[0].descriptor.endpoints).toEqual([{ id: 'window', type: 'window', address: 'safari-extension' }])
    await expect(f.client.connect(providers[0])).rejects.toMatchObject({
      domain: 'brc185',
      code: 'CONFIGURATION_ERROR',
      delivery: 'not-sent'
    })
  })

  it('describe verifies under the real origin and a fresh challenge', async () => {
    world = createWorld()
    const f = world.newFrame()
    const { providers, rejected } = await f.client.discover()
    expect(rejected).toEqual([])
    expect(providers[0].descriptor).toMatchObject({ version: 1, vendor: 'org.bsvblockchain.wallet' })
    // The same descriptor does not verify for another origin (the preimage covers the origin).
    const other = world.newFrame({ tabId: 2, url: 'https://other.example/' })
    const second = await other.client.discover()
    expect(second.providers[0].descriptor.instanceId).toBe(providers[0].descriptor.instanceId)
  })

  it('a forged window.postMessage reaches only its own content script', async () => {
    world = createWorld()
    const a = world.newFrame({ tabId: 1 })
    const b = world.newFrame({ tabId: 2, url: 'https://b.example/' })
    await tick()
    const connA = await connected(a)
    expect(connA.epoch).toBeDefined()
    const before = b.sent.length
    // A page in frame A forges every message type at its own window.
    for (const data of [
      { type: 'bsv-bridge:port' },
      { type: 'bsv-bridge:content-ready' },
      { type: 'brc185:invoke', version: 1, kind: 'connect' }
    ]) {
      a.win.postMessage(data, '*')
    }
    await tick(30)
    expect(b.sent.length).toBe(before) // nothing crossed to B
    // and A's own wire still works after the forgeries
    const again = await a.client.invoke(connA, 'getVersion')
    expect(again).toEqual({ version: 'vendor-1.0.0' })
  })

  it('routing fields mismatch, unknown method and invoke before connect are PROTOCOL_ERROR not-sent before staging', async () => {
    world = createWorld()
    const page = world.rawFrame()
    const epoch = '22222222-2222-4222-8222-222222222222'
    const instanceId = '11111111-1111-4111-8111-111111111111'
    const invoke = (over: Record<string, unknown>) => ({
      type: 'brc185:invoke',
      version: 1,
      instanceId,
      epoch,
      id: '33333333-3333-4333-8333-333333333333',
      method: 'getHeight',
      params: {},
      ...over
    })
    const answerFor = async (id: string) => {
      await until(() => page.replies.some(r => r.id === id), 'reply')
      return page.replies.find(r => r.id === id)
    }

    // invoke before connect
    page.send(invoke({}))
    expect((await answerFor('33333333-3333-4333-8333-333333333333')).error).toMatchObject({
      domain: 'brc185',
      code: 'PROTOCOL_ERROR',
      delivery: 'not-sent'
    })

    // connect, then a wrong instanceId, a wrong epoch and an unknown method
    const r = await page.control({ kind: 'connect', origin: ORIGIN, epoch })
    expect(r.ok).toBe(true)
    const goodInstance = r.value.instanceId
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        '44444444-4444-4444-8444-444444444444',
        { id: '44444444-4444-4444-8444-444444444444', instanceId: '99999999-9999-4999-8999-999999999999' }
      ],
      [
        '55555555-5555-4555-8555-555555555555',
        {
          id: '55555555-5555-4555-8555-555555555555',
          instanceId: goodInstance,
          epoch: '88888888-8888-4888-8888-888888888888'
        }
      ],
      [
        '66666666-6666-4666-8666-666666666666',
        { id: '66666666-6666-4666-8666-666666666666', instanceId: goodInstance, method: 'notAMethod' }
      ]
    ]
    for (const [id, over] of cases) {
      page.send(invoke(over))
      expect((await answerFor(id)).error).toMatchObject({ code: 'PROTOCOL_ERROR', delivery: 'not-sent' })
    }
    expect(world.appex.records.size).toBe(0)
    expect(world.browser.tabs.updates).toHaveLength(0)
    expect(world.appex.requests.filter(q => q.op.startsWith('stage'))).toHaveLength(0)
  })

  it('onClose reasons account-changed, revoked and lost reach the page', async () => {
    world = createWorld()
    const f = world.newFrame()
    const conn = await connected(f)
    const key = (e: string) => ({ instanceId: conn.provider.descriptor.instanceId, epoch: e })
    // lost: the mirror disappears (logout)
    world.appex.mirrorState = 'absent'
    await f.relay.poll()
    await until(() => conn.closed.length === 1, 'onClose')
    expect(conn.closed).toEqual(['lost'])
    void key

    // account-changed: new revision on a second connection
    world.appex.mirrorState = 'ok'
    world.appex.mirror = makeMirror({ revision: '5' })
    const g = world.newFrame({ tabId: 2 })
    const conn2 = await connected(g)
    world.appex.mirror = makeMirror({ revision: '6' })
    await g.relay.poll()
    await until(() => conn2.closed.length === 1)
    expect(conn2.closed).toEqual(['account-changed'])

    // revoked: an app event
    world.appex.mirror = makeMirror({ revision: '6' })
    const h = world.newFrame({ tabId: 3 })
    const conn3 = await connected(h)
    world.appex.events.push({
      v: 1,
      closeSeq: 1,
      instanceId: conn3.provider.descriptor.instanceId,
      epoch: conn3.epoch,
      reason: 'revoked'
    })
    await h.relay.poll()
    await until(() => conn3.closed.length === 1)
    expect(conn3.closed).toEqual(['revoked'])
    // the next call on a closed connection fails locally, not-sent
    await expect(h.client.invoke(conn3, 'getVersion')).rejects.toMatchObject({
      code: 'CONNECTION_CLOSED',
      delivery: 'not-sent'
    })
  })

  it('profile switch: a call on the old epoch is refused and the page is told', async () => {
    world = createWorld()
    const f = world.newFrame()
    const conn = await connected(f)
    expect(await f.client.invoke(conn, 'isAuthenticated')).toEqual({ authenticated: true })
    world.appex.mirror = makeMirror({ revision: '9', accountContext: 'ctx-b' })
    // the next call reconciles first: the old epoch is closed and the call is not sent
    const err: any = await f.client.invoke(conn, 'isAuthenticated').catch(e => e)
    expect(err).toMatchObject({ domain: 'brc185', code: 'PROVIDER_CHANGED', delivery: 'not-sent' })
    await f.relay.poll()
    await until(() => conn.closed.length === 1)
    expect(conn.closed).toEqual(['account-changed'])
    expect(world.appex.records.size).toBe(0)
  })

  it('all 28 methods are carried with their JSON shapes; three are answered locally', async () => {
    world = createWorld()
    world.appex.mirror = makeMirror({ connected: [connectedHash(ORIGIN)], identityKey: '02' + 'cd'.repeat(32) })
    const f = world.newFrame()
    const conn = await connected(f)
    const local = new Set(['getVersion', 'isAuthenticated'])
    const names = Object.keys(BRIDGE_METHODS)
    expect(names).toHaveLength(28)
    for (const method of names) {
      const args =
        method === 'getPublicKey'
          ? { identityKey: true }
          : { n: method.length, nested: { list: [1, 2, 3], s: 'x', t: true, nil: null } }
      const before = world.appex.records.size
      const p = f.client.invoke(conn, method as never, args)
      if (local.has(method) || method === 'getPublicKey') {
        // answered from the mirror: nothing is staged
        const r: any = await p
        expect(world.appex.records.size).toBe(before)
        if (method === 'getPublicKey') expect(r).toEqual({ publicKey: '02' + 'cd'.repeat(32) })
        continue
      }
      await until(() => world.appex.records.size === before + 1, `record for ${method}`)
      const { id, json } = lastRecord(world)
      expect(json).toMatchObject({ v: 1, kind: 'invoke', method, args, epoch: conn.epoch })
      const result = { echoed: method, shape: { a: [1, { b: null }] } }
      answer(world, id, result)
      await f.relay.poll()
      await expect(p).resolves.toEqual(result)
    }
  })

  it('a wallet error rejects with the wallet error unchanged; a ConnectionError with domain brc185', async () => {
    world = createWorld()
    const f = world.newFrame()
    const conn = await connected(f)
    const p = f.client.invoke(conn, 'createAction', { description: 'x' })
    await until(() => world.appex.records.size === 1)
    const { id } = lastRecord(world)
    const walletError = { code: 6, message: 'Insufficient funds', data: { needed: 10 } }
    world.appex.resultBytes.set(id, utf8Bytes(JSON.stringify({ v: 1, id, ok: false, error: walletError })))
    await f.relay.poll()
    await expect(p).rejects.toEqual(walletError)

    const q = f.client.invoke(conn, 'createAction', { description: 'y' })
    await until(() => world.appex.records.size === 2)
    const second = lastRecord(world)
    const ce = { domain: 'brc185', code: 'PROVIDER_CHANGED', message: 'gone', delivery: 'not-sent' }
    world.appex.resultBytes.set(second.id, utf8Bytes(JSON.stringify({ v: 1, id: second.id, ok: false, error: ce })))
    await f.relay.poll()
    const err = await q.catch(e => e)
    expect(err).toEqual(ce)
    expect(isConnectionError(err)).toBe(true)
  })

  it('disconnect(epoch) is not echoed as closed, and the next call fails locally', async () => {
    world = createWorld()
    const f = world.newFrame()
    const conn = await connected(f)
    await conn.disconnect()
    await f.relay.poll()
    await tick(30)
    expect(conn.closed).toEqual([])
    await expect(f.client.invoke(conn, 'getVersion')).rejects.toMatchObject({
      code: 'CONNECTION_CLOSED',
      delivery: 'not-sent'
    })
  })
})
