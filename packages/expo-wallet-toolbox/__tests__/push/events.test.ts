import {
  attachPushHandlers,
  coalesceRuns,
  PUSH_SYNC_TIMEOUT_MS,
  __resetInitialNotificationForTests
} from '../../core/push/events'
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

// Push failures are logged (never thrown). Keep test output pristine and let
// the tests that exercise failures assert on what was logged.
let warn: jest.SpyInstance
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
})
const warned = () => warn.mock.calls.map(c => c.join(' ')).join('\n')

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
    expect(warned()).toContain('[push]')
    expect(warned()).toContain('onForegroundMessage')
    expect(warned()).toContain('native Firebase app missing')
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
    expect(warned()).toContain('[push] getInitialNotification')
  })
  it('an initial-notification read that rejects is logged, not thrown', async () => {
    const { adapter } = fakeAdapter(null)
    ;(adapter.getInitialNotification as jest.Mock).mockRejectedValue(new Error('read failed'))
    attachPushHandlers({ adapter, requestInboxPass: jest.fn(), openActivity: jest.fn(), onTokenRefresh: jest.fn() })
    await flush()
    expect(warned()).toContain('[push] getInitialNotification')
    expect(warned()).toContain('read failed')
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
    expect(warned()).toContain('[push] unsubscribe')
    expect(warned()).toContain('already gone')
  })
  it('a callback that throws is logged and does not skip the rest of the tap handling', () => {
    const { adapter, handlers } = fakeAdapter(null)
    const requestInboxPass = jest.fn(() => {
      throw new Error('pass failed')
    })
    const openActivity = jest.fn()
    attachPushHandlers({ adapter, requestInboxPass, openActivity, onTokenRefresh: jest.fn() })
    expect(() => handlers.opened({ data: {} })).not.toThrow()
    expect(openActivity).toHaveBeenCalledTimes(1)
    expect(warned()).toContain('[push] requestInboxPass')
    expect(warned()).toContain('pass failed')
  })
  it('never logs the push payload or token', () => {
    const { adapter, handlers } = fakeAdapter(null)
    const requestInboxPass = jest.fn(() => {
      throw new Error('boom')
    })
    attachPushHandlers({ adapter, requestInboxPass, openActivity: jest.fn(), onTokenRefresh: jest.fn() })
    handlers.fg({ data: { messageId: 'SECRET-MESSAGE-ID' } })
    handlers.tok('SECRET-FCM-TOKEN')
    expect(warned()).not.toContain('SECRET-MESSAGE-ID')
    expect(warned()).not.toContain('SECRET-FCM-TOKEN')
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
    expect(warned()).toContain('[push] registration sync')
    expect(warned()).toContain('boom')
  })

  describe('timeout', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })
    afterEach(() => {
      jest.useRealTimers()
    })

    // A run whose promise is only settled by the test, like a fetch that never returns.
    function hanging() {
      const settle: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
      const run = jest.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            settle.push({ resolve, reject })
          })
      )
      return { run, settle }
    }

    it('is 30 seconds', () => {
      expect(PUSH_SYNC_TIMEOUT_MS).toBe(30_000)
    })

    it('gives up on a hung run after the timeout, logs it, and settles the caller', async () => {
      const h = hanging()
      const sync = coalesceRuns(h.run)
      let done = false
      const p = sync().then(() => {
        done = true
      })
      await jest.advanceTimersByTimeAsync(PUSH_SYNC_TIMEOUT_MS - 1)
      expect(done).toBe(false)
      expect(warn).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(1)
      await p
      expect(done).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warned()).toContain('[push] registration sync failed: timed out')
    })

    it('releases the lock so a later call runs instead of waiting on the hung one', async () => {
      const h = hanging()
      const sync = coalesceRuns(h.run)
      const first = sync()
      await jest.advanceTimersByTimeAsync(PUSH_SYNC_TIMEOUT_MS)
      await first
      expect(h.run).toHaveBeenCalledTimes(1)

      const second = sync()
      await jest.advanceTimersByTimeAsync(0)
      expect(h.run).toHaveBeenCalledTimes(2)
      h.settle[1].resolve()
      await second
    })

    it('still folds calls that landed during the hang into one rerun after the timeout', async () => {
      const h = hanging()
      const sync = coalesceRuns(h.run)
      const first = sync()
      await jest.advanceTimersByTimeAsync(10)
      const p2 = sync()
      const p3 = sync()
      expect(h.run).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(PUSH_SYNC_TIMEOUT_MS)
      expect(h.run).toHaveBeenCalledTimes(2)
      h.settle[1].resolve()
      await Promise.all([first, p2, p3])
      expect(h.run).toHaveBeenCalledTimes(2)
    })

    it('ignores a timed-out run that settles later, resolved or rejected', async () => {
      const h = hanging()
      const sync = coalesceRuns(h.run)
      const first = sync()
      await jest.advanceTimersByTimeAsync(PUSH_SYNC_TIMEOUT_MS)
      await first
      const logged = warn.mock.calls.length

      h.settle[0].reject(new Error('late failure'))
      await jest.advanceTimersByTimeAsync(0)
      expect(warn.mock.calls.length).toBe(logged)
      expect(warned()).not.toContain('late failure')

      const second = sync()
      await jest.advanceTimersByTimeAsync(0)
      h.settle[1].resolve()
      await second
      expect(h.run).toHaveBeenCalledTimes(2)
    })

    it('leaves no timer behind after a run that finishes in time or fails fast', async () => {
      const ok = coalesceRuns(async () => {})
      await ok()
      expect(jest.getTimerCount()).toBe(0)
      const bad = coalesceRuns(async () => {
        throw new Error('boom')
      })
      await bad()
      expect(jest.getTimerCount()).toBe(0)
      expect(warned()).toContain('boom')
      expect(warned()).not.toContain('timed out')
    })
  })
})
