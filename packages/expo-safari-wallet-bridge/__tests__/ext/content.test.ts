/** @jest-environment node */
import { POLL_STEPS_MS } from '../../shared/constants'
import { utf8Bytes } from '../../extension/src/lib/bytes'
import { createWorld, until, type Frame, type World } from './chain'

let world: World
afterEach(() => world?.dispose())

async function connect(f: Frame) {
  return f.client.connect((await f.client.discover()).providers[0])
}

describe('content relay polling', () => {
  it('schedules 1 s, 2 s, then 5 s steps while a call is pending and the page is visible, and stops when hidden', async () => {
    world = createWorld()
    const f = world.newFrame()
    const conn = await connect(f)
    void f.client.invoke(conn, 'createAction', { description: 'x' }).catch(() => undefined)
    await until(() => f.relay.pendingCount() === 1)
    await until(() => world.timers.delays().length === 1)
    const seen: number[] = []
    for (let i = 0; i < 4; i++) {
      seen.push(world.timers.delays()[0])
      world.timers.fire()
      await until(() => world.timers.delays().length === 1, 'next step')
    }
    expect(seen).toEqual([...POLL_STEPS_MS, POLL_STEPS_MS[POLL_STEPS_MS.length - 1]])
    f.win.fire('hidden')
    expect(world.timers.delays()).toHaveLength(0)
    const before = f.sent.length
    f.win.fire('visible')
    await until(() => f.sent.length > before, 'poll on visible')
    await until(() => world.timers.delays().length === 1)
    expect(world.timers.delays()).toEqual([POLL_STEPS_MS[0]])
  })

  it.each(['visible', 'focus', 'pageshow'] as const)('%s triggers a poll', async trigger => {
    world = createWorld()
    const f = world.newFrame()
    const conn = await connect(f)
    void f.client.invoke(conn, 'createAction', { description: 'x' }).catch(() => undefined)
    await until(() => f.relay.pendingCount() === 1)
    await f.relay.poll()
    const before = f.sent.filter(m => m.bsv === 'poll').length
    f.win.fire(trigger)
    await until(() => f.sent.filter(m => m.bsv === 'poll').length > before, `poll after ${trigger}`)
  })

  it('the next call is also a poll trigger', async () => {
    world = createWorld()
    const f = world.newFrame()
    const conn = await connect(f)
    void f.client.invoke(conn, 'createAction', { description: 'x' }).catch(() => undefined)
    await until(() => f.relay.pendingCount() === 1)
    await f.relay.poll()
    const before = f.sent.filter(m => m.bsv === 'poll').length
    void f.client.invoke(conn, 'listOutputs', { basket: 'a' }).catch(() => undefined)
    await until(() => f.sent.filter(m => m.bsv === 'poll').length > before, 'poll after the next call')
  })

  it('a result arriving while the page was hidden is delivered at the next trigger', async () => {
    world = createWorld()
    const f = world.newFrame()
    const conn = await connect(f)
    f.win.fire('hidden')
    const p = f.client.invoke(conn, 'createAction', { description: 'x' })
    await until(() => world.appex.records.size === 1)
    const [id] = [...world.appex.records.keys()]
    world.appex.resultBytes.set(id, utf8Bytes(JSON.stringify({ v: 1, id, ok: true, result: { done: 1 } })))
    expect(world.timers.delays()).toHaveLength(0)
    f.win.fire('focus')
    await expect(p).resolves.toEqual({ done: 1 })
  })

  it('a purged result converts to CONNECTION_CLOSED unknown', async () => {
    world = createWorld()
    const f = world.newFrame()
    const conn = await connect(f)
    const p = f.client.invoke(conn, 'createAction', { description: 'x' })
    await until(() => world.appex.records.size === 1)
    world.appex.purged.add([...world.appex.records.keys()][0])
    await f.relay.poll()
    await expect(p).rejects.toMatchObject({ code: 'CONNECTION_CLOSED', delivery: 'unknown' })
  })

  it('a transport failure on invoke is retried with the same invoke id and stages once', async () => {
    world = createWorld()
    const f = world.newFrame()
    const conn = await connect(f)
    // the first reply is lost: the background unloaded between stage and reply
    const real = world.bg.handleMessage
    let dropped = false
    world.bg.handleMessage = async (m: any, s: any) => {
      const r = await real(m, s)
      if (m.bsv === 'invoke' && !dropped) {
        dropped = true
        throw new Error('The background was unloaded')
      }
      return r
    }
    const p = f.client.invoke(conn, 'createAction', { description: 'x' })
    await until(() => world.appex.records.size === 1)
    await until(() => f.relay.pendingCount() === 1)
    const invokes = f.sent.filter(m => m.bsv === 'invoke')
    expect(invokes).toHaveLength(2)
    expect(invokes[0].id).toBe(invokes[1].id)
    expect(world.appex.records.size).toBe(1)
    const [id] = [...world.appex.records.keys()]
    world.appex.resultBytes.set(id, utf8Bytes(JSON.stringify({ v: 1, id, ok: true, result: 7 })))
    await f.relay.poll()
    await expect(p).resolves.toBe(7)
  })

  it('a call whose record can never produce a result is closed, not left waiting', async () => {
    world = createWorld()
    const f = world.newFrame()
    const conn = await connect(f)
    const p = f.client.invoke(conn, 'createAction', { description: 'x' })
    await until(() => world.appex.records.size === 1)
    await world.browser.session.remove('bsv.unresolved') // the table is gone (epoch closed after its grace)
    await f.relay.poll()
    await expect(p).rejects.toMatchObject({ code: 'CONNECTION_CLOSED', delivery: 'unknown' })
  })

  it("disconnect rejects the page's pending calls with DISCONNECTED unknown", async () => {
    world = createWorld()
    const f = world.newFrame()
    const conn = await connect(f)
    const p = f.client.invoke(conn, 'createAction', { description: 'x' })
    await until(() => f.relay.pendingCount() === 1)
    await conn.disconnect()
    await expect(p).rejects.toMatchObject({ code: 'DISCONNECTED', delivery: 'unknown' })
    expect(f.relay.pendingCount()).toBe(0)
  })

  it('the long-lived port exists only while an epoch is held', async () => {
    world = createWorld()
    const f = world.newFrame()
    expect(f.ports).toHaveLength(0)
    const conn = await connect(f)
    expect(f.ports).toHaveLength(1)
    expect(f.ports[0].disconnected).toBe(false)
    await conn.disconnect()
    expect(f.ports[0].disconnected).toBe(true)
  })
})
