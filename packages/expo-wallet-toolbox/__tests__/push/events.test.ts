import { attachPushHandlers, coalesceRuns, __resetInitialNotificationForTests } from '../../core/push/events'
import type { PushAdapter, PushOpenedEvent } from '../../core/push/types'

function fakeAdapter(initial: PushOpenedEvent | null) {
  const handlers: Record<string, (e?: any) => void> = {}
  const adapter = {
    platform: 'ios',
    getInitialNotification: jest.fn().mockResolvedValue(initial),
    onNotificationOpened: jest.fn(cb => ((handlers.opened = cb), () => delete handlers.opened)),
    onForegroundMessage: jest.fn(cb => ((handlers.fg = cb), () => delete handlers.fg)),
    onTokenRefresh: jest.fn(cb => ((handlers.tok = cb), () => delete handlers.tok))
  } as unknown as PushAdapter
  return { adapter, handlers }
}
const flush = () => new Promise(r => setImmediate(r))

describe('attachPushHandlers', () => {
  beforeEach(() => __resetInitialNotificationForTests())
  it('consumes initial notification once', async () => {
    const { adapter } = fakeAdapter({ data: { messageId: 'm1' } })
    const requestInboxPass = jest.fn(),
      openActivity = jest.fn()
    attachPushHandlers({ adapter, requestInboxPass, openActivity, onTokenRefresh: jest.fn() })()
    attachPushHandlers({ adapter, requestInboxPass, openActivity, onTokenRefresh: jest.fn() })
    await flush()
    expect(openActivity).toHaveBeenCalledTimes(1)
    expect(requestInboxPass).toHaveBeenCalledTimes(1)
  })
  it('tap while backgrounded opens activity and requests a pass', () => {
    const { adapter, handlers } = fakeAdapter(null)
    const requestInboxPass = jest.fn(),
      openActivity = jest.fn()
    attachPushHandlers({ adapter, requestInboxPass, openActivity, onTokenRefresh: jest.fn() })
    handlers.opened({ data: {} })
    expect(openActivity).toHaveBeenCalled()
    expect(requestInboxPass).toHaveBeenCalled()
  })
  it('foreground message only requests an inbox pass', () => {
    const { adapter, handlers } = fakeAdapter(null)
    const requestInboxPass = jest.fn(),
      openActivity = jest.fn()
    attachPushHandlers({ adapter, requestInboxPass, openActivity, onTokenRefresh: jest.fn() })
    handlers.fg({ data: {} })
    expect(requestInboxPass).toHaveBeenCalled()
    expect(openActivity).not.toHaveBeenCalled()
  })
  it('token refresh calls onTokenRefresh', () => {
    const { adapter, handlers } = fakeAdapter(null)
    const onTokenRefresh = jest.fn()
    attachPushHandlers({ adapter, requestInboxPass: jest.fn(), openActivity: jest.fn(), onTokenRefresh })
    handlers.tok('new-token')
    expect(onTokenRefresh).toHaveBeenCalledTimes(1)
  })
  it('unsubscribe removes every listener', () => {
    const { adapter, handlers } = fakeAdapter(null)
    attachPushHandlers({ adapter, requestInboxPass: jest.fn(), openActivity: jest.fn(), onTokenRefresh: jest.fn() })()
    expect(Object.keys(handlers)).toEqual([])
  })
  it('a listener that throws on subscribe does not break attach or the other listeners', () => {
    const { adapter, handlers } = fakeAdapter(null)
    ;(adapter.onForegroundMessage as jest.Mock).mockImplementation(() => {
      throw new Error('native Firebase app missing')
    })
    const requestInboxPass = jest.fn(),
      openActivity = jest.fn(),
      onTokenRefresh = jest.fn()
    let detach: () => void = () => {}
    expect(() => {
      detach = attachPushHandlers({ adapter, requestInboxPass, openActivity, onTokenRefresh })
    }).not.toThrow()
    handlers.opened({ data: {} })
    handlers.tok('t')
    expect(openActivity).toHaveBeenCalledTimes(1)
    expect(onTokenRefresh).toHaveBeenCalledTimes(1)
    expect(() => detach()).not.toThrow()
    expect(Object.keys(handlers)).toEqual([])
  })
  it('an initial-notification read that throws synchronously does not break attach', () => {
    const { adapter, handlers } = fakeAdapter(null)
    ;(adapter.getInitialNotification as jest.Mock).mockImplementation(() => {
      throw new Error('native Firebase app missing')
    })
    expect(() =>
      attachPushHandlers({ adapter, requestInboxPass: jest.fn(), openActivity: jest.fn(), onTokenRefresh: jest.fn() })
    ).not.toThrow()
    expect(Object.keys(handlers).sort()).toEqual(['fg', 'opened', 'tok'])
  })
  it('an unsubscribe that throws does not stop the others being removed', () => {
    const { adapter, handlers } = fakeAdapter(null)
    ;(adapter.onNotificationOpened as jest.Mock).mockImplementation(() => () => {
      throw new Error('already gone')
    })
    const detach = attachPushHandlers({
      adapter,
      requestInboxPass: jest.fn(),
      openActivity: jest.fn(),
      onTokenRefresh: jest.fn()
    })
    expect(() => detach()).not.toThrow()
    expect(Object.keys(handlers)).toEqual([])
  })
})

describe('coalesceRuns', () => {
  function gated() {
    const gates: Array<() => void> = []
    let active = 0
    let peak = 0
    let calls = 0
    const run = jest.fn(async () => {
      calls++
      active++
      peak = Math.max(peak, active)
      await new Promise<void>(r => gates.push(r))
      active--
    })
    return { run, gates, stats: () => ({ calls, peak }) }
  }

  it('runs once when called once', async () => {
    const g = gated()
    const sync = coalesceRuns(g.run)
    const p = sync()
    await flush()
    g.gates[0]()
    await p
    expect(g.stats()).toEqual({ calls: 1, peak: 1 })
  })
  it('never overlaps, and folds N overlapping calls into exactly one rerun', async () => {
    const g = gated()
    const sync = coalesceRuns(g.run)
    const first = sync()
    await flush()
    const p2 = sync()
    const p3 = sync()
    const p4 = sync()
    await flush()
    expect(g.stats().calls).toBe(1)
    g.gates[0]()
    await flush()
    // the single coalesced rerun has started, not three
    expect(g.stats().calls).toBe(2)
    g.gates[1]()
    await Promise.all([first, p2, p3, p4])
    expect(g.stats()).toEqual({ calls: 2, peak: 1 })
  })
  it('a call after everything settled starts a fresh run', async () => {
    const g = gated()
    const sync = coalesceRuns(g.run)
    const a = sync()
    await flush()
    g.gates[0]()
    await a
    const b = sync()
    await flush()
    g.gates[1]()
    await b
    expect(g.stats()).toEqual({ calls: 2, peak: 1 })
  })
  it('a run that rejects does not wedge later calls and never rejects the caller', async () => {
    let n = 0
    const sync = coalesceRuns(async () => {
      n++
      if (n === 1) throw new Error('boom')
    })
    await expect(sync()).resolves.toBeUndefined()
    await expect(sync()).resolves.toBeUndefined()
    expect(n).toBe(2)
  })
})
