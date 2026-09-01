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
  subscribeOnline: jest.fn(() => () => {})
}))

import { act, renderHook } from '@testing-library/react-native'
import { getOnline, subscribeOnline } from '@bsv/expo-wallet-toolbox'
import { useOnline } from '../../ui/hooks/useOnline'

const probe = getOnline as jest.Mock

/** Two turns: one for the promise, one for Node to declare a rejection unhandled. */
const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })
}

describe('useOnline', () => {
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
})
