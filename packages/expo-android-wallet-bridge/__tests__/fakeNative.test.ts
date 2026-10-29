import { createFakeNative } from '../src/testing/fakeNative'

describe('fake native', () => {
  it('takeLaunches is destructive and drops entries older than 120 s', () => {
    const n = createFakeNative()
    n.pushLaunch('intent://a', 0)
    n.pushLaunch('intent://old', 0)
    n.advance(119_000)
    n.pushLaunch('intent://b', 5_000)
    n.advance(2_000)
    // 'a' and 'old' are 121 s old and dropped; 'b' was created 5 s before t=119 s, so it is 7 s old now.
    const first = n.takeLaunches()
    expect(first.map(l => l.uri)).toEqual(['intent://b'])
    expect(first[0].ageMs).toBe(7_000)
    expect(n.takeLaunches()).toEqual([])
  })

  it('takeLaunches keeps an entry exactly 120 s old and evicts the oldest past 32', () => {
    const n = createFakeNative()
    n.pushLaunch('intent://edge', 120_000)
    expect(n.takeLaunches().map(l => l.uri)).toEqual(['intent://edge'])
    for (let i = 0; i < 33; i++) n.pushLaunch(`intent://${i}`, 0)
    const out = n.takeLaunches()
    expect(out).toHaveLength(32)
    expect(out[0].uri).toBe('intent://1')
  })

  it('emitLaunch stores the URI and nudges with its seq', () => {
    const n = createFakeNative()
    const seen: number[] = []
    n.addListener('onLaunch', p => seen.push(p.seq))
    const seq = n.emitLaunch('intent://x')
    expect(seen).toEqual([seq])
    expect(n.takeLaunches()).toHaveLength(1)
  })

  it('named timers fire in order under advance', () => {
    const n = createFakeNative()
    const fired: string[] = []
    n.addListener('onTimer', p => fired.push(p.name))
    n.setTimer('c', 300)
    n.setTimer('a', 100)
    n.setTimer('b', 200)
    n.setTimer('same1', 150)
    n.setTimer('same2', 150)
    n.clearTimer('c')
    n.advance(99)
    expect(fired).toEqual([])
    n.advance(1000)
    expect(fired).toEqual(['a', 'same1', 'same2', 'b'])
    expect(n.activeTimers()).toEqual([])
  })

  it('a timer set by a timer handler fires within the same advance and re-setting replaces', () => {
    const n = createFakeNative()
    const fired: string[] = []
    n.addListener('onTimer', p => {
      fired.push(p.name)
      if (p.name === 'first') n.setTimer('second', 50)
    })
    n.setTimer('first', 100)
    n.setTimer('r', 10)
    n.setTimer('r', 500)
    n.advance(200)
    expect(fired).toEqual(['first', 'second'])
    expect(n.elapsedRealtime()).toBe(200)
  })

  it('respond captures, and resolves false once the peer is gone', async () => {
    const n = createFakeNative()
    n.emitRequest({ id: '1' })
    expect(await n.respond('1', 200, [['x', 'y']], 'ok')).toBe(true)
    expect(n.responses).toEqual([{ id: '1', status: 200, headers: [['x', 'y']], body: 'ok' }])
    n.emitGone('2')
    expect(await n.respond('2', 200, [], '')).toBe(false)
    expect(n.responses).toHaveLength(1)
  })

  it('ensureService follows the toggle and listeners can be removed', async () => {
    const n = createFakeNative()
    expect(await n.ensureService()).toBe(true)
    n.ensureServiceResult = false
    expect(await n.ensureService()).toBe(false)
    const seen: string[] = []
    const sub = n.addListener('onClientGone', p => seen.push(p.id))
    n.emitGone('a')
    sub.remove()
    n.emitGone('b')
    expect(seen).toEqual(['a'])
  })
})
