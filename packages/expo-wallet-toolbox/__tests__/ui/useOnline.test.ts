/**
 * `useOnline` is mounted by /pay (app/pay.tsx). A `NetInfo.fetch()` that rejects
 * must not become an unhandled rejection there: under this repo's Jest setup a
 * real `getOnline()` rejection is enough to take the process down (Task 11 found
 * that the hard way), which is the same shape of failure a device hits at mount.
 * The optimistic initial `true` plus `subscribeOnline`'s updates are a perfectly
 * good answer without it.
 */
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  getOnline: jest.fn(),
  subscribeOnline: jest.fn(() => () => {}),
  probeOnline: jest.fn()
}))

import { act, renderHook } from '@testing-library/react-native'
import { getOnline, probeOnline, subscribeOnline } from '@bsv/expo-wallet-toolbox'
import { useOnline } from '../../ui/hooks/useOnline'

const probe = getOnline as jest.Mock
const live = probeOnline as jest.Mock

/** Two turns: one for the promise, one for Node to declare a rejection unhandled. */
const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })
}

describe('useOnline', () => {
  let warn: jest.SpyInstance
  beforeEach(() => {
    live.mockReset()
    // The "NetInfo was wrong" breadcrumb is expected in several cases below.
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('leaves no unhandled rejection when the connectivity probe fails', async () => {
    const unhandled: unknown[] = []
    const listener = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', listener)
    try {
      probe.mockRejectedValue(new Error('NetInfo native module unavailable'))
      const { result } = renderHook(() => useOnline())
      await settle()

      expect(unhandled).toEqual([])
      // Still optimistic: a first render that wrongly says offline hides the
      // online rails from a user who has signal, which is the worse mistake.
      expect(result.current).toBe(true)
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('adopts an online probe result immediately', async () => {
    probe.mockResolvedValue(true)
    const { result } = renderHook(() => useOnline(10))
    await settle()
    expect(result.current).toBe(true)
  })

  // The home screen showed an offline banner to phones that were online the
  // whole time, because the first connectivity report arrives before anything
  // has been established. Offline is now claimed only once it has held.
  it('does not claim offline until the state has held for the confirm window', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    try {
      probe.mockResolvedValue(false)
      live.mockResolvedValue(false)
      const { result } = renderHook(() => useOnline(2500))
      await settle()
      expect(result.current).toBe(true)

      await act(async () => {
        jest.advanceTimersByTime(2499)
      })
      expect(result.current).toBe(true)

      await act(async () => {
        jest.advanceTimersByTime(1)
      })
      await settle()
      expect(result.current).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('cancels a pending offline claim when connectivity comes back first', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    try {
      probe.mockResolvedValue(false)
      let emit: ((v: boolean) => void) | undefined
      ;(subscribeOnline as jest.Mock).mockImplementation((cb: (v: boolean) => void) => {
        emit = cb
        return () => {}
      })
      const { result } = renderHook(() => useOnline(2500))
      await settle()

      await act(async () => {
        jest.advanceTimersByTime(1000)
        emit?.(true)
        jest.advanceTimersByTime(5000)
      })
      // A blip that resolved before the window elapsed never reaches the user.
      expect(result.current).toBe(true)
    } finally {
      jest.useRealTimers()
      ;(subscribeOnline as jest.Mock).mockImplementation(() => () => {})
    }
  })

  // The bug behind the banner shown to a phone that was online the whole time:
  // NetInfo's verdict is a cached snapshot (iOS delivers no reachability
  // callbacks while suspended, and its cache is never re-read) plus, on iOS, a
  // HEAD to a Google host. Either can say offline indefinitely for a device
  // with a working connection. An offline verdict is therefore a claim to
  // check against a real request, not a fact.
  it('does not claim offline when NetInfo says so but a live request gets through', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    try {
      probe.mockResolvedValue(false)
      live.mockResolvedValue(true)
      const { result } = renderHook(() => useOnline(2500))
      await settle()

      await act(async () => {
        jest.advanceTimersByTime(2500)
      })
      await settle()

      expect(live).toHaveBeenCalled()
      expect(result.current).toBe(true)
      // Leaves a breadcrumb saying NetInfo was the one that was wrong.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[net] NetInfo reports offline'))
    } finally {
      jest.useRealTimers()
    }
  })

  it('claims offline once the live request fails as well', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    try {
      probe.mockResolvedValue(false)
      live.mockResolvedValue(false)
      const { result } = renderHook(() => useOnline(2500))
      await settle()

      await act(async () => {
        jest.advanceTimersByTime(2500)
      })
      await settle()

      expect(live).toHaveBeenCalledTimes(1)
      expect(result.current).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  // NetInfo will not emit again for a stale snapshot, so a banner that only
  // NetInfo can clear would stay up until the next network change.
  it('clears the banner by itself once a later live request gets through', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    try {
      probe.mockResolvedValue(false)
      live.mockResolvedValueOnce(false).mockResolvedValue(true)
      const { result } = renderHook(() => useOnline(2500, 15000))
      await settle()

      await act(async () => {
        jest.advanceTimersByTime(2500)
      })
      await settle()
      expect(result.current).toBe(false)

      await act(async () => {
        jest.advanceTimersByTime(15000)
      })
      await settle()
      expect(result.current).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('stops re-checking once NetInfo reports connectivity back', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    try {
      probe.mockResolvedValue(false)
      live.mockResolvedValue(false)
      let emit: ((v: boolean) => void) | undefined
      ;(subscribeOnline as jest.Mock).mockImplementation((cb: (v: boolean) => void) => {
        emit = cb
        return () => {}
      })
      const { result } = renderHook(() => useOnline(2500, 15000))
      await settle()
      await act(async () => {
        jest.advanceTimersByTime(2500)
      })
      await settle()
      expect(result.current).toBe(false)

      await act(async () => {
        emit?.(true)
      })
      expect(result.current).toBe(true)
      const callsWhenBack = live.mock.calls.length

      await act(async () => {
        jest.advanceTimersByTime(60000)
      })
      await settle()
      expect(live.mock.calls.length).toBe(callsWhenBack)
    } finally {
      jest.useRealTimers()
      ;(subscribeOnline as jest.Mock).mockImplementation(() => () => {})
    }
  })

  it('stops re-checking when unmounted', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    try {
      probe.mockResolvedValue(false)
      live.mockResolvedValue(false)
      const { unmount } = renderHook(() => useOnline(2500, 15000))
      await settle()
      await act(async () => {
        jest.advanceTimersByTime(2500)
      })
      await settle()
      const callsWhenUnmounted = live.mock.calls.length
      unmount()

      await act(async () => {
        jest.advanceTimersByTime(60000)
      })
      await settle()
      expect(live.mock.calls.length).toBe(callsWhenUnmounted)
    } finally {
      jest.useRealTimers()
    }
  })
})
