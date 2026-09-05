/**
 * `useVaultBalance` must not refetch while a vault transfer is mid-flight
 * (ceremony phase 'preparing' / 'broadcasting'): in that window the spent
 * vault UTXO is gone and its change is still unsent, so `listOutputs` reads 0
 * — a partial withdrawal would flash "balance: 0" at exactly the moment the
 * user is most nervous. The last known figure stays up until the ceremony
 * leaves the busy window, then one refresh adopts the real post-transfer
 * balance (the busy→idle transition itself must refetch, because any
 * txStatusVersion bumps that landed DURING the freeze were deliberately
 * swallowed).
 */
let mockWalletCtx: { managers: unknown; adminOriginator: string; txStatusVersion: number }
let mockVaultPhase: string

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  useWallet: () => mockWalletCtx,
  useVault: () => ({ state: { phase: mockVaultPhase }, submitPin: () => {}, cancel: () => {}, retry: () => {} }),
  getVaultBalance: jest.fn()
}))

import { act, renderHook } from '@testing-library/react-native'
import { getVaultBalance } from '@bsv/expo-wallet-toolbox'
import { useVaultBalance } from '../../ui/hooks/useVaultBalance'

const fetchBalance = getVaultBalance as jest.Mock

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })
}

beforeEach(() => {
  fetchBalance.mockReset()
  mockWalletCtx = { managers: { permissionsManager: {} }, adminOriginator: 'admin', txStatusVersion: 0 }
  mockVaultPhase = 'idle'
})

describe('useVaultBalance', () => {
  test('idle: fetches on mount and again on a txStatusVersion bump', async () => {
    fetchBalance.mockResolvedValue(500)
    const { result, rerender } = renderHook(() => useVaultBalance())
    await settle()
    expect(result.current.balance).toBe(500)
    expect(fetchBalance).toHaveBeenCalledTimes(1)

    mockWalletCtx = { ...mockWalletCtx, txStatusVersion: 1 }
    rerender(undefined)
    await settle()
    expect(fetchBalance).toHaveBeenCalledTimes(2)
  })

  test.each(['preparing', 'broadcasting'])(
    'freezes during %s: a txStatusVersion bump does not refetch and the last figure stays up',
    async phase => {
      fetchBalance.mockResolvedValue(500)
      const { result, rerender } = renderHook(() => useVaultBalance())
      await settle()
      expect(result.current.balance).toBe(500)

      // Transfer in flight: the vault UTXO is spent, its change not yet
      // spendable — a fetch here would read 0.
      mockVaultPhase = phase
      fetchBalance.mockResolvedValue(0)
      mockWalletCtx = { ...mockWalletCtx, txStatusVersion: 1 }
      rerender(undefined)
      await settle()

      expect(fetchBalance).toHaveBeenCalledTimes(1) // no refetch during the freeze
      expect(result.current.balance).toBe(500) // last known figure survives
    }
  )

  test('leaving the busy window refetches once and adopts the real post-transfer balance', async () => {
    fetchBalance.mockResolvedValue(500)
    const { result, rerender } = renderHook(() => useVaultBalance())
    await settle()

    mockVaultPhase = 'broadcasting'
    mockWalletCtx = { ...mockWalletCtx, txStatusVersion: 1 } // bump swallowed by the freeze
    rerender(undefined)
    await settle()
    expect(fetchBalance).toHaveBeenCalledTimes(1)

    // Broadcast done, ceremony released → the change output is now real.
    mockVaultPhase = 'idle'
    fetchBalance.mockResolvedValue(320)
    rerender(undefined)
    await settle()
    expect(fetchBalance).toHaveBeenCalledTimes(2) // the thaw itself refetches
    expect(result.current.balance).toBe(320)
  })

  test('coalesces invalidations during a read and publishes only the fresh result', async () => {
    const first = deferred<number>()
    fetchBalance.mockReturnValueOnce(first.promise).mockResolvedValue(320)
    const { result, rerender } = renderHook(() => useVaultBalance())
    await settle()

    for (const txStatusVersion of [1, 2]) {
      mockWalletCtx = { ...mockWalletCtx, txStatusVersion }
      rerender(undefined)
      await settle()
    }
    act(() => result.current.refresh())
    await settle()
    expect(fetchBalance).toHaveBeenCalledTimes(1)

    await act(async () => first.resolve(500))
    await settle()
    expect(fetchBalance).toHaveBeenCalledTimes(2)
    expect(result.current.balance).toBe(320)
    expect(result.current.loading).toBe(false)
  })

  test.each(['preparing', 'broadcasting'])(
    'discards a pending read and ignores manual refresh while %s',
    async phase => {
      const pending = deferred<number>()
      fetchBalance.mockResolvedValueOnce(500).mockReturnValueOnce(pending.promise).mockResolvedValue(320)
      const { result, rerender } = renderHook(() => useVaultBalance())
      await settle()

      act(() => result.current.refresh())
      await settle()
      mockVaultPhase = phase
      rerender(undefined)
      act(() => result.current.refresh())
      await settle()
      expect(fetchBalance).toHaveBeenCalledTimes(2)

      await act(async () => pending.resolve(0))
      await settle()
      expect(result.current.balance).toBe(500)

      mockVaultPhase = 'idle'
      rerender(undefined)
      await settle()
      expect(fetchBalance).toHaveBeenCalledTimes(3)
      expect(result.current.balance).toBe(320)
    }
  )

  test('retains a queued refresh after a read fails', async () => {
    const first = deferred<number>()
    fetchBalance.mockReturnValueOnce(first.promise).mockResolvedValue(320)
    const { result } = renderHook(() => useVaultBalance())
    await settle()
    act(() => result.current.refresh())
    await act(async () => first.reject(new Error('temporary read failure')))
    await settle()
    expect(fetchBalance).toHaveBeenCalledTimes(2)
    expect(result.current.balance).toBe(320)
    expect(result.current.loading).toBe(false)
  })

  test('ignores a previous wallet read after its manager is replaced', async () => {
    const first = deferred<number>()
    const next = deferred<number>()
    fetchBalance.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise)
    const { result, rerender } = renderHook(() => useVaultBalance())
    await settle()

    const replacement = {}
    mockWalletCtx = { ...mockWalletCtx, managers: { permissionsManager: replacement } }
    rerender(undefined)
    await act(async () => first.resolve(500))
    await settle()
    expect(result.current.balance).toBeNull()
    expect(result.current.loading).toBe(true)
    expect(fetchBalance).toHaveBeenLastCalledWith(replacement, 'admin')

    await act(async () => next.resolve(320))
    await settle()
    expect(result.current.balance).toBe(320)
    expect(result.current.loading).toBe(false)
  })

  test('drops queued reads when unmounted', async () => {
    const first = deferred<number>()
    fetchBalance.mockReturnValueOnce(first.promise).mockResolvedValue(320)
    const { result, unmount } = renderHook(() => useVaultBalance())
    await settle()
    act(() => result.current.refresh())
    unmount()
    await act(async () => first.resolve(500))
    await settle()
    expect(fetchBalance).toHaveBeenCalledTimes(1)
  })
})
