/** @jest-environment node */
import { createBackground } from '../../extension/src/lib/backgroundRouter'
import { loadBindings } from '../../extension/src/lib/bindings'
import { utf8Bytes } from '../../extension/src/lib/bytes'
import { CLOSING_GRACE_MS } from '../../shared/constants'
import { connectedHash } from '../../shared/mirror'
import { createWorld, until, type World } from './chain'
import { makeMirror } from './fakeBrowser'

const ORIGIN = 'https://app.example'
const EPOCH = '22222222-2222-4222-8222-222222222222'
const INVOKE = '33333333-3333-4333-8333-333333333333'
let world: World

afterEach(() => world?.dispose())

const sender = (over: Record<string, unknown> = {}) => ({
  tab: { id: 1, incognito: false, url: `${ORIGIN}/x` },
  frameId: 0,
  url: `${ORIGIN}/x`,
  origin: ORIGIN,
  ...over
})

async function bound(w: World) {
  const r: any = await w.bg.handleMessage({ bsv: 'connect', origin: ORIGIN, epoch: EPOCH }, sender())
  expect(r.ok).toBe(true)
  return r.value.instanceId as string
}

const invokeMsg = (instanceId: string, over: Record<string, unknown> = {}) => ({
  bsv: 'invoke',
  instanceId,
  epoch: EPOCH,
  id: INVOKE,
  method: 'createAction',
  params: { description: 'pay' },
  ...over
})

describe('background router', () => {
  it('ping answers without touching native', async () => {
    world = createWorld()
    expect(await world.bg.handleMessage({ type: 'ping' }, sender())).toMatchObject({
      pong: true,
      name: 'Bitcoin SV Wallet'
    })
    expect(world.appex.requests).toHaveLength(0)
  })

  it('unknown requests and senders without a usable origin are PROTOCOL_ERROR not-sent', async () => {
    world = createWorld()
    expect(await world.bg.handleMessage({ bsv: 'nope' }, sender())).toMatchObject({
      ok: false,
      error: { code: 'PROTOCOL_ERROR', delivery: 'not-sent' }
    })
    expect(await world.bg.handleMessage('x', sender())).toMatchObject({ ok: false })
    for (const s of [
      { tab: undefined },
      { url: 'about:blank', origin: undefined },
      { origin: 'null', url: undefined }
    ]) {
      const r: any = await world.bg.handleMessage({ bsv: 'describe', origin: ORIGIN, challenge: 'x' }, sender(s))
      expect(r).toMatchObject({ ok: false, error: { code: 'PROTOCOL_ERROR', delivery: 'not-sent' } })
    }
  })

  it('invoke: a frame other than the one that connected is refused before staging', async () => {
    world = createWorld()
    const instanceId = await bound(world)
    const r: any = await world.bg.handleMessage(invokeMsg(instanceId), sender({ frameId: 7 }))
    expect(r).toMatchObject({ ok: false, error: { code: 'PROTOCOL_ERROR', delivery: 'not-sent' } })
    const r2: any = await world.bg.handleMessage(invokeMsg(instanceId), sender({ tab: { id: 2, incognito: false } }))
    expect(r2).toMatchObject({ ok: false, error: { code: 'PROTOCOL_ERROR' } })
    expect(world.appex.records.size).toBe(0)
  })

  it('invoke: malformed fields and unknown methods never reach the appex', async () => {
    world = createWorld()
    const instanceId = await bound(world)
    const before = world.appex.requests.length
    for (const over of [{ method: 'bogus' }, { id: 'x' }, { epoch: 'x' }, { instanceId: 5 }, { method: 7 }]) {
      const r: any = await world.bg.handleMessage(invokeMsg(instanceId, over), sender())
      expect(r).toMatchObject({ ok: false, error: { code: 'PROTOCOL_ERROR', delivery: 'not-sent' } })
    }
    expect(world.appex.requests.length).toBe(before)
  })

  it('invoke: staged is acknowledged before the handoff, and the handoff never delays the reply', async () => {
    world = createWorld()
    const instanceId = await bound(world)
    let release!: () => void
    world.browser.tabs.update = (tabId, props) =>
      new Promise(resolve => {
        release = () => resolve({ tabId, ...props })
      }) as never
    const reply: any = await world.bg.handleMessage(invokeMsg(instanceId), sender())
    expect(reply).toMatchObject({ ok: true, value: { kind: 'staged' } })
    expect(world.appex.records.has(reply.value.recordId)).toBe(true)
    await until(() => typeof release === 'function', 'handoff started')
    release()
  })

  it('handoff url carries no id, origin or payload; three records in 3 s share one handoff', async () => {
    world = createWorld()
    const instanceId = await bound(world)
    const urls = () => world.browser.tabs.updates.map(u => u.url as string)
    for (let n = 0; n < 3; n++) {
      await world.bg.handleMessage(invokeMsg(instanceId, { id: `33333333-3333-4333-8333-33333333333${n}` }), sender())
      world.clock.t += 500
    }
    await until(() => urls().length >= 1, 'handoff')
    expect(urls()).toHaveLength(1)
    expect(urls()[0]).toMatch(/^org\.bsvblockchain\.wallet:\/\/bridge\?v=1&n=[0-9a-f]+$/)
    expect(urls()[0]).not.toContain(INVOKE)
    expect(urls()[0]).not.toContain('app.example')
  })

  it('repeat invoke after background reload does not stage twice (Review Focus 3)', async () => {
    world = createWorld()
    const instanceId = await bound(world)
    const first: any = await world.bg.handleMessage(invokeMsg(instanceId), sender())
    expect(first.ok).toBe(true)
    // The background is unloaded and loaded again: new instance, same session storage.
    const reloaded = createBackground(world.deps)
    const second: any = await reloaded.handleMessage(invokeMsg(instanceId), sender())
    expect(second).toMatchObject({ ok: true, value: { kind: 'staged', recordId: first.value.recordId } })
    expect(world.appex.records.size).toBe(1)
  })

  it('a result for an id the page already resolved is ignored and re-acked (Review Focus 5)', async () => {
    world = createWorld()
    const instanceId = await bound(world)
    const staged: any = await world.bg.handleMessage(invokeMsg(instanceId), sender())
    const id = staged.value.recordId
    const bytes = utf8Bytes(JSON.stringify({ v: 1, id, ok: true, result: { txid: 'aa' } }))
    world.appex.resultBytes.set(id, bytes)
    const first: any = await world.bg.handleMessage({ bsv: 'poll', ids: [id], epochs: [] }, sender())
    expect(first.value.items).toEqual([{ id, kind: 'result', result: { txid: 'aa' } }])
    // the ack was lost: the app still has it and the page polls again with the same id
    world.appex.resultBytes.set(id, bytes)
    const second: any = await world.bg.handleMessage({ bsv: 'poll', ids: [id], epochs: [] }, sender())
    expect(second.value.items.filter((i: any) => i.kind === 'result')).toHaveLength(0)
    expect(world.appex.acked.filter(x => x === id)).toHaveLength(2)
  })

  it('local answers need the epoch to be bound; reconcile runs first', async () => {
    world = createWorld()
    world.appex.mirror = makeMirror({ connected: [connectedHash(ORIGIN)], identityKey: '02' + 'ab'.repeat(32) })
    const instanceId = await bound(world)
    const r: any = await world.bg.handleMessage(
      invokeMsg(instanceId, { method: 'getPublicKey', params: { identityKey: true } }),
      sender()
    )
    expect(r.value).toEqual({ kind: 'local', result: { publicKey: '02' + 'ab'.repeat(32) } })
    world.appex.mirrorState = 'absent'
    const after: any = await world.bg.handleMessage(
      invokeMsg(instanceId, {
        method: 'getPublicKey',
        params: { identityKey: true },
        id: '44444444-4444-4444-8444-444444444444'
      }),
      sender()
    )
    expect(after).toMatchObject({ ok: false, error: { code: 'CONNECTION_CLOSED', delivery: 'not-sent' } })
  })

  describe('tab lifecycle', () => {
    const stagedKinds = (w: World) =>
      [...w.appex.records.values()].map(r => JSON.parse(Buffer.from(r.bytes).toString('utf8')).kind)

    it('tab close, frame unload and bfcache re-register within 5 s write no disconnect', async () => {
      world = createWorld()
      const f = world.newFrame()
      const { providers } = await f.client.discover()
      const conn = await f.client.connect(providers[0])
      await f.client.invoke(conn, 'getVersion')
      const p = f.client.invoke(conn, 'createAction', { description: 'x' })
      void p.catch(() => undefined)
      await until(() => world.appex.records.size === 1)

      // the frame goes away (unload / bfcache): its port disconnects
      f.ports[0].disconnect()
      await world.bg.idle()
      world.clock.t += CLOSING_GRACE_MS - 1000
      // page restored from the bfcache: pageshow polls with the held epochs, which re-registers them
      f.win.fire('pageshow')
      await until(() => f.ports.length === 2, 'reconnect')
      await f.relay.poll()
      world.clock.t += CLOSING_GRACE_MS * 2
      world.bgTimers.fire()
      await world.bg.idle()
      expect(stagedKinds(world)).toEqual(['invoke'])
      expect(Object.keys(await loadBindings(world.browser.session))).toHaveLength(1)
    })

    it('disconnect is written after the grace, only for epochs that staged, and with no handoff', async () => {
      world = createWorld()
      const a = world.newFrame({ tabId: 1 })
      const b = world.newFrame({ tabId: 2 })
      const ca = await a.client.connect((await a.client.discover()).providers[0])
      const cb = await b.client.connect((await b.client.discover()).providers[0])
      void a.client.invoke(ca, 'createAction', { description: 'x' }).catch(() => undefined)
      void cb // b never staged anything
      await until(() => world.appex.records.size === 1)
      await until(() => world.browser.tabs.updates.length === 1, 'handoff')
      const handoffs = world.browser.tabs.updates.length

      world.bg.onTabRemoved(1)
      world.bg.onTabRemoved(2)
      await world.bg.idle()
      expect(stagedKinds(world)).toEqual(['invoke']) // not before the grace
      world.clock.t += CLOSING_GRACE_MS + 100
      expect(world.bgTimers.delays().length).toBeGreaterThan(0)
      world.bgTimers.fire()
      await world.bg.idle()
      await until(() => world.appex.records.size === 2, 'disconnect record')
      expect(stagedKinds(world).sort()).toEqual(['disconnect', 'invoke'])
      expect(world.browser.tabs.updates).toHaveLength(handoffs) // no handoff for a disconnect
      // the epoch that never staged is just forgotten
      expect(Object.keys(await loadBindings(world.browser.session))).toHaveLength(0)
    })

    it('a tab closed while the background was unloaded is detected by tabs.query at next wake', async () => {
      world = createWorld()
      const f = world.newFrame({ tabId: 5 })
      const conn = await f.client.connect((await f.client.discover()).providers[0])
      void f.client.invoke(conn, 'createAction', { description: 'x' }).catch(() => undefined)
      await until(() => world.appex.records.size === 1)
      world.browser.tabs.open.delete(5) // the tab died; nobody heard
      const reloaded = createBackground(world.deps)
      await reloaded.handleMessage({ type: 'ping' }, sender())
      await reloaded.handleMessage({ bsv: 'poll', ids: [], epochs: [] }, sender({ tab: { id: 9, incognito: false } }))
      world.clock.t += CLOSING_GRACE_MS + 100
      await reloaded.handleMessage({ bsv: 'poll', ids: [], epochs: [] }, sender({ tab: { id: 9, incognito: false } }))
      await until(() => world.appex.records.size === 2, 'disconnect record')
      expect(stagedKinds(world).sort()).toEqual(['disconnect', 'invoke'])
    })

    it('the app does not tell the page about a page-initiated disconnect, and navigation to the handoff url is ignored', async () => {
      world = createWorld()
      const f = world.newFrame()
      const conn = await f.client.connect((await f.client.discover()).providers[0])
      void f.client.invoke(conn, 'createAction', { description: 'x' }).catch(() => undefined)
      await until(() => world.appex.records.size === 1)
      world.bg.onTabUpdated(1, { url: 'org.bsvblockchain.wallet://bridge?v=1&n=abc' })
      world.bg.onTabUpdated(1, { url: `${ORIGIN}/other-route` }) // same origin: not acted on
      await world.bg.idle()
      expect(world.bgTimers.delays()).toHaveLength(0)
      world.bg.onTabUpdated(1, { url: 'https://elsewhere.example/' }) // another origin: the documents are gone
      await world.bg.idle()
      expect(world.bgTimers.delays().length).toBe(1)
    })
  })

  describe('in-flight calls when the container disappears (Review Focus 4)', () => {
    it('rejects CONNECTION_CLOSED with delivery unknown, and tells the page lost', async () => {
      world = createWorld()
      const f = world.newFrame()
      const conn = await f.client.connect((await f.client.discover()).providers[0])
      const p = f.client.invoke(conn, 'createAction', { description: 'x' })
      const settled = p.then(
        () => ({ ok: true }),
        e => ({ ok: false, e })
      )
      await until(() => world.appex.records.size === 1)
      world.appex.mirrorState = 'absent' // logout / Delete Wallet reset the container
      world.appex.records.clear()
      await f.relay.poll()
      const out: any = await settled
      expect(out.ok).toBe(false)
      expect(out.e).toMatchObject({ domain: 'brc185', code: 'CONNECTION_CLOSED', delivery: 'unknown' })
      await until(() => conn.closed.length === 1)
      expect(conn.closed).toEqual(['lost'])
    })
  })
})
