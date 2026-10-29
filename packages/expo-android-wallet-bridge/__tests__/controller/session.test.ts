import type { BridgeSnapshot } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'
import { createFakeNative } from '../../src/testing/fakeNative'
import { createBindingLedger } from '../../src/controller/bindingLedger'
import { createLaunchRegistry } from '../../src/controller/launchRegistry'
import { createSession } from '../../src/controller/session'
import { SCHEME, epochOf, flush, snapshot, uriOf } from './support'

const MIN = 60_000

function setup(initial: Partial<BridgeSnapshot> = {}) {
  const native = createFakeNative()
  const registry = createLaunchRegistry({ native, scheme: SCHEME })
  const clock = () => native.elapsedRealtime()
  const ledger = createBindingLedger(clock)
  let snap = snapshot(initial)
  const closed: string[] = []
  const holder: { session?: ReturnType<typeof createSession> } = {}
  const session = createSession({
    native,
    registry,
    ledger,
    closeLost(epoch) {
      closed.push(epoch)
      ledger.close(epoch)
      holder.session!.onBindingClosed(epoch)
    },
    getSnapshot: () => snap,
    clock
  })
  holder.session = session
  native.addListener('onTimer', p => session.onTimer(p.name))
  const launch = async (i: number, ageMs = 0) => {
    native.pushLaunch(uriOf(i), ageMs)
    registry.ingest()
    session.onLaunch()
    await flush()
  }
  /** What the router does for an accepted connect. */
  const connect = (i: number) => {
    expect(registry.take(epochOf(i))).toBeDefined()
    ledger.open(epochOf(i), 'https://a.example', new Uint8Array(32))
    session.onConnect(epochOf(i))
  }
  const setSnap = (patch: Partial<BridgeSnapshot>) => {
    snap = { ...snap, ...patch }
  }
  return { native, registry, ledger, session, closed, launch, connect, setSnap, getSnap: () => snap }
}

const names = (n: ReturnType<typeof createFakeNative>) => n.calls.map(c => c.name)

describe('session machine', () => {
  it('launch arms: ensureService then startServer(3321, 63)', async () => {
    const t = setup()
    expect(t.session.state()).toBe('IDLE')
    await t.launch(1)
    expect(t.session.state()).toBe('ARMED')
    const order = names(t.native).filter(n => n === 'ensureService' || n === 'startServer')
    expect(order).toEqual(['ensureService', 'startServer'])
    expect(t.native.calls.find(c => c.name === 'startServer')!.args[0]).toEqual({ basePort: 3321, maxOffset: 63 })
  })

  it('ensureService false leaves IDLE with no listener and keeps the record unburnt', async () => {
    const t = setup()
    t.native.ensureServiceResult = false
    await t.launch(1)
    expect(t.session.state()).toBe('IDLE')
    expect(names(t.native)).not.toContain('startServer')
    expect(t.native.serverRunning).toBe(false)
    expect(t.registry.hasLive()).toBe(true)
    // One retry within the record's life succeeds on the same record.
    t.native.ensureServiceResult = true
    t.native.advance(30_000)
    t.session.onLaunch()
    await flush()
    expect(t.session.state()).toBe('ARMED')
    expect(t.registry.take(epochOf(1))).toBeDefined()
  })

  it('startServer failure stays IDLE and stops the service', async () => {
    const t = setup()
    t.native.startServerResult = new Error('ports exhausted')
    await t.launch(1)
    expect(t.session.state()).toBe('IDLE')
    expect(names(t.native)).toContain('stopSession')
  })

  it('armed expires 120 s after the last launch', async () => {
    const t = setup()
    await t.launch(1)
    t.native.advance(100_000)
    await t.launch(2)
    t.native.advance(119_000)
    expect(t.session.state()).toBe('ARMED')
    t.native.advance(1_001)
    expect(t.session.state()).toBe('IDLE')
    expect(names(t.native)).toContain('stopServer')
    expect(names(t.native)).toContain('stopSession')
  })

  it('chain cap 10 min even with a stream of launches', async () => {
    const t = setup()
    await t.launch(0)
    for (let i = 1; i <= 5; i++) {
      t.native.advance(100_000)
      await t.launch(i)
      expect(t.session.state()).toBe('ARMED')
    }
    // 500 s so far; the sixth launch at 590 s would still be inside the cap.
    t.native.advance(90_000)
    await t.launch(6)
    expect(t.session.state()).toBe('ARMED')
    t.native.advance(10_001)
    expect(t.session.state()).toBe('IDLE')
  })

  it('a parked connect keeps ARMED until resolved or its 10-minute deadline', async () => {
    const t = setup({ readiness: 'building' })
    await t.launch(1)
    expect(t.registry.take(epochOf(1))).toBeDefined()
    const p = t.session.parkConnect('c1', 'https://a.example', epochOf(1))
    t.native.advance(10 * MIN - 1)
    expect(t.session.state()).toBe('ARMED')
    t.native.advance(2)
    await expect(p).resolves.toBe('unavailable')
    expect(t.session.state()).toBe('IDLE')
  })

  it('a parked connect released as ready resumes and the armed expiry is rechecked', async () => {
    const t = setup({ readiness: 'building' })
    await t.launch(1)
    t.registry.take(epochOf(1))
    const p = t.session.parkConnect('c1', 'https://a.example', epochOf(1))
    t.native.advance(121_000)
    expect(t.session.state()).toBe('ARMED')
    t.setSnap({ readiness: 'ready' })
    t.session.onSnapshot()
    await expect(p).resolves.toBe('resume')
    // The released connect failed without opening a binding: ARMED still expires.
    t.native.advance(6_000)
    expect(t.session.state()).toBe('IDLE')
  })

  it('connect moves to ACTIVE, last binding closing with no live record returns to IDLE', async () => {
    const t = setup()
    await t.launch(1)
    t.connect(1)
    expect(t.session.state()).toBe('ACTIVE')
    expect(t.native.activeTimers().map(x => x.name)).toEqual(expect.arrayContaining(['reaper']))
    expect(t.native.activeTimers().map(x => x.name)).not.toContain('armed')
    t.session.onBindingClosed(epochOf(1))
    expect(t.session.state()).toBe('IDLE')
    expect(t.native.serverRunning).toBe(false)
  })

  it('last binding closing with a live record goes back to ARMED', async () => {
    const t = setup()
    await t.launch(1)
    await t.launch(2)
    t.connect(1)
    t.session.onBindingClosed(epochOf(1))
    expect(t.session.state()).toBe('ARMED')
    expect(t.native.serverRunning).toBe(true)
  })

  it('host detach stops server and closes all lost, a live record re-arms only on re-attach', async () => {
    const t = setup()
    await t.launch(1)
    await t.launch(2)
    t.connect(1)
    t.session.onHostAttached(false)
    expect(t.closed).toEqual([epochOf(1)])
    expect(t.session.state()).toBe('IDLE')
    expect(t.native.serverRunning).toBe(false)
    // A launch while detached keeps its record but does not arm.
    await t.launch(3)
    expect(t.session.state()).toBe('IDLE')
    expect(t.registry.hasLive()).toBe(true)
    t.setSnap({ hostAttached: true })
    t.session.onHostAttached(true)
    await flush()
    expect(t.session.state()).toBe('ARMED')
    expect(t.native.serverRunning).toBe(true)
  })

  it('detach during a parked connect answers 503 and re-attach does not resume it', async () => {
    const t = setup({ hostAttached: false, readiness: 'none' })
    await t.launch(1)
    expect(t.session.state()).toBe('ARMED')
    t.registry.take(epochOf(1))
    const p = t.session.parkConnect('c1', 'https://a.example', epochOf(1))
    // Attach, then detach before the wallet is ready.
    t.setSnap({ hostAttached: true, readiness: 'building' })
    t.session.onHostAttached(true)
    t.setSnap({ hostAttached: false, readiness: 'none' })
    t.session.onHostAttached(false)
    await expect(p).resolves.toBe('unavailable')
    expect(t.session.parkedCount()).toBe(0)
    t.setSnap({ hostAttached: true, readiness: 'ready' })
    t.session.onHostAttached(true)
    await flush()
    // The burnt record is not resurrected and nothing is parked or connected.
    expect(t.registry.take(epochOf(1))).toBeUndefined()
    expect(t.session.parkedCount()).toBe(0)
    expect(t.session.state()).toBe('IDLE')
  })

  it('readiness follows the snapshot: park, none-fail, go', () => {
    const t = setup({ hostAttached: false })
    expect(t.session.readiness()).toBe('park')
    t.setSnap({ hostAttached: true, readiness: 'none' })
    expect(t.session.readiness()).toBe('none-fail')
    t.setSnap({ readiness: 'building' })
    expect(t.session.readiness()).toBe('park')
    t.setSnap({ readiness: 'blocked' })
    expect(t.session.readiness()).toBe('park')
    t.setSnap({ readiness: 'ready' })
    expect(t.session.readiness()).toBe('go')
  })

  it('attach with no wallet answers parked connects unavailable', async () => {
    const t = setup({ hostAttached: false, readiness: 'none' })
    await t.launch(1)
    t.registry.take(epochOf(1))
    const p = t.session.parkConnect('c1', 'https://a.example', epochOf(1))
    t.setSnap({ hostAttached: true, readiness: 'none' })
    t.session.onHostAttached(true)
    await expect(p).resolves.toBe('unavailable')
  })

  it('parked connects capped at 4 (fifth 429)', async () => {
    const t = setup({ readiness: 'building' })
    for (let i = 0; i < 5; i++) await t.launch(i)
    const results: Promise<string>[] = []
    for (let i = 0; i < 5; i++) {
      t.registry.take(epochOf(i))
      results.push(t.session.parkConnect(`c${i}`, 'https://a.example', epochOf(i)))
    }
    expect(t.session.parkedCount()).toBe(4)
    await expect(results[4]).resolves.toBe('full')
  })

  it('reaper closes idle 30 min only without parked or in-flight requests', async () => {
    const t = setup()
    await t.launch(1)
    t.connect(1)
    t.ledger.markSettled(epochOf(1))
    t.session.onSettled(epochOf(1))
    t.native.advance(29 * MIN)
    expect(t.closed).toEqual([])
    t.ledger.inFlight(epochOf(1), 1)
    t.native.advance(10 * MIN)
    expect(t.closed).toEqual([])
    t.ledger.inFlight(epochOf(1), -1)
    // Idle clock restarts when the request finishes: 30 min from here.
    t.native.advance(29 * MIN)
    expect(t.closed).toEqual([])
    t.native.advance(2 * MIN)
    expect(t.closed).toEqual([epochOf(1)])
    expect(t.session.state()).toBe('IDLE')
  })

  it('unsettled 60 s closes lost only with nothing parked', async () => {
    const t = setup()
    await t.launch(1)
    await t.launch(2)
    t.connect(1)
    t.ledger.parked(epochOf(1), 1)
    t.native.advance(61_000)
    expect(t.closed).toEqual([])
    t.ledger.parked(epochOf(1), -1)
    t.native.advance(61_000)
    expect(t.closed).toEqual([epochOf(1)])
  })

  it('a settled binding is not closed by the unsettled expiry', async () => {
    const t = setup()
    await t.launch(1)
    t.connect(1)
    t.ledger.markSettled(epochOf(1))
    t.session.onSettled(epochOf(1))
    t.native.advance(5 * MIN)
    expect(t.closed).toEqual([])
  })

  it('server stop closes all lost', async () => {
    const t = setup()
    await t.launch(1)
    await t.launch(2)
    t.connect(1)
    t.registry.take(epochOf(2))
    t.ledger.open(epochOf(2), 'https://b.example', new Uint8Array(32))
    t.session.onConnect(epochOf(2))
    t.native.emitServerStopped('user-disconnect')
    t.session.onServerStopped()
    expect(t.closed.sort()).toEqual([epochOf(1), epochOf(2)].sort())
    expect(t.session.state()).toBe('IDLE')
  })

  it('client gone while a connect is parked drops it, frees the parked slot, and the launch record stays burnt', async () => {
    const t = setup({ readiness: 'building' })
    for (let i = 0; i < 5; i++) await t.launch(i)
    const ps: Promise<string>[] = []
    for (let i = 0; i < 4; i++) {
      t.registry.take(epochOf(i))
      ps.push(t.session.parkConnect(`c${i}`, 'https://a.example', epochOf(i)))
    }
    t.session.onClientGone('c0')
    await expect(ps[0]).resolves.toBe('dropped')
    expect(t.session.parkedCount()).toBe(3)
    t.registry.take(epochOf(4))
    const fifth = t.session.parkConnect('c4', 'https://a.example', epochOf(4))
    expect(t.session.parkedCount()).toBe(4)
    t.session.onClientGone('c4')
    await expect(fifth).resolves.toBe('dropped')
    // Burnt, tombstoned: neither epoch can be used again, even if Kotlin hands the URI over again.
    expect(t.registry.take(epochOf(0))).toBeUndefined()
    t.native.pushLaunch(uriOf(0), 0)
    t.registry.ingest()
    expect(t.registry.take(epochOf(0))).toBeUndefined()
    // The timer of a dropped connect is gone.
    expect(t.native.activeTimers().map(x => x.name)).not.toContain('parked:c0')
  })

  it('the reaper and the unsettled expiry read idleSince and isSettled from the ledger', async () => {
    const t = setup()
    await t.launch(1)
    t.connect(1)
    const idle = jest.spyOn(t.ledger, 'idleSince')
    const settled = jest.spyOn(t.ledger, 'isSettled')
    t.native.advance(61_000)
    expect(settled).toHaveBeenCalledWith(epochOf(1))
    expect(idle).toHaveBeenCalledWith(epochOf(1))
  })

  it('setSession reports counts only', async () => {
    const t = setup()
    await t.launch(1)
    t.connect(1)
    t.session.setWaiting(2)
    const last = t.native.calls.filter(c => c.name === 'setSession').pop()!
    expect(last.args).toEqual([1, 2])
  })
})
