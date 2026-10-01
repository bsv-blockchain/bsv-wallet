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

describe('attachPushHandlers: which profile a push is for', () => {
  beforeEach(() => __resetInitialNotificationForTests())
  const OTHER = '03'.padEnd(66, 'b')

  /** A resolver that knows one inactive profile (index 2) by its identity key. */
  const resolve = jest.fn((recipient: string): number | undefined => (recipient === OTHER ? 2 : undefined))
  beforeEach(() => resolve.mockClear())

  function attach(initial: PushOpenedEvent | null = null, switchProfile?: (i: number) => Promise<boolean>) {
    const { adapter, handlers } = fakeAdapter(initial)
    const calls: string[] = []
    const requestInboxPass = jest.fn(() => void calls.push('pass'))
    const openActivity = jest.fn(() => void calls.push('open'))
    const sw = switchProfile ?? jest.fn(async (_i: number) => (calls.push('switched'), true))
    attachPushHandlers({
      adapter,
      requestInboxPass,
      openActivity,
      onTokenRefresh: jest.fn(),
      resolveInactiveProfile: resolve,
      switchProfile: sw
    })
    return { handlers, calls, requestInboxPass, openActivity, switchProfile: sw as jest.Mock }
  }

  it('a tap for an inactive profile switches to it first, then opens Activity', async () => {
    const a = attach()
    a.handlers.opened({ data: { recipient: OTHER, messageBox: 'payment_inbox' } })
    expect(a.switchProfile).toHaveBeenCalledWith(2)
    // Nothing opens on the profile being left while the switch is under way.
    expect(a.openActivity).not.toHaveBeenCalled()
    await flush()
    expect(a.calls).toEqual(['switched', 'pass', 'open'])
  })

  it('a cold-start tap for an inactive profile routes the same way', async () => {
    const a = attach({ data: { recipient: OTHER } })
    await flush()
    expect(a.switchProfile).toHaveBeenCalledWith(2)
    expect(a.calls).toEqual(['switched', 'pass', 'open'])
  })

  it('a tap for the open profile (or any recipient that is not an inactive one) behaves as before', async () => {
    const a = attach()
    a.handlers.opened({ data: { recipient: '02'.padEnd(66, 'a') } })
    await flush()
    expect(resolve).toHaveBeenCalledWith('02'.padEnd(66, 'a'))
    expect(a.switchProfile).not.toHaveBeenCalled()
    expect(a.calls).toEqual(['pass', 'open'])
  })

  it('a tap with no recipient (a server from before it was added) behaves as before, without asking', async () => {
    const a = attach()
    a.handlers.opened({ data: { messageId: 'm1' } })
    a.handlers.opened({ data: { recipient: '' } })
    await flush()
    expect(resolve).not.toHaveBeenCalled()
    expect(a.switchProfile).not.toHaveBeenCalled()
    expect(a.calls).toEqual(['pass', 'open', 'pass', 'open'])
  })

  it('a switch that does not land leaves the user where they were: no Activity, no pass', async () => {
    const a = attach(
      null,
      jest.fn(async () => false)
    )
    a.handlers.opened({ data: { recipient: OTHER } })
    await flush()
    expect(a.calls).toEqual([])
  })

  it('a switch that throws is logged, contained, and opens nothing', async () => {
    const a = attach(
      null,
      jest.fn(async () => {
        throw new Error('build failed')
      })
    )
    expect(() => a.handlers.opened({ data: { recipient: OTHER } })).not.toThrow()
    await flush()
    expect(a.calls).toEqual([])
    expect(warned()).toContain('[push] switchProfile failed: build failed')
  })

  it('a resolver that throws is logged and the tap behaves as before', async () => {
    const { adapter, handlers } = fakeAdapter(null)
    const requestInboxPass = jest.fn(),
      openActivity = jest.fn()
    attachPushHandlers({
      adapter,
      requestInboxPass,
      openActivity,
      onTokenRefresh: jest.fn(),
      resolveInactiveProfile: () => {
        throw new Error('store unreadable')
      },
      switchProfile: jest.fn()
    })
    handlers.opened({ data: { recipient: OTHER } })
    await flush()
    expect(openActivity).toHaveBeenCalledTimes(1)
    expect(warned()).toContain('[push] resolveInactiveProfile failed: store unreadable')
  })

  it('without a switch (or a resolver) a tap behaves as before', async () => {
    const { adapter, handlers } = fakeAdapter(null)
    const openActivity = jest.fn()
    attachPushHandlers({
      adapter,
      requestInboxPass: jest.fn(),
      openActivity,
      onTokenRefresh: jest.fn(),
      resolveInactiveProfile: resolve
    })
    handlers.opened({ data: { recipient: OTHER } })
    await flush()
    expect(openActivity).toHaveBeenCalledTimes(1)
  })

  it("a foreground message for an inactive profile does not run the open profile's inbox pass", () => {
    const a = attach()
    a.handlers.fg({ data: { recipient: OTHER } })
    expect(a.requestInboxPass).not.toHaveBeenCalled()
    expect(a.switchProfile).not.toHaveBeenCalled()
    expect(a.openActivity).not.toHaveBeenCalled()
  })

  it.each([
    ['for the open profile', { recipient: '02'.padEnd(66, 'a') }],
    ['for an identity this device does not know', { recipient: '03'.padEnd(66, 'f') }],
    ['with no recipient', { messageId: 'm1' }]
  ])('a foreground message %s still requests the inbox pass', (_name, data) => {
    const a = attach()
    a.handlers.fg({ data })
    expect(a.requestInboxPass).toHaveBeenCalledTimes(1)
  })

  it('never logs the recipient', async () => {
    const a = attach(
      null,
      jest.fn(async () => {
        throw new Error('boom')
      })
    )
    a.handlers.opened({ data: { recipient: OTHER } })
    await flush()
    expect(warned()).not.toContain(OTHER)
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
