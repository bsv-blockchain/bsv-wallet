/**
 * useVaultCoverage feeds the vault screen's "N deposits not yet open to X"
 * badges and the Remove-key safety check. It must follow the same
 * invalidation signals as useVaultBalance (mount, txStatusVersion, manual
 * refresh) and the same freeze while a transfer is in flight, and it must
 * report `null` — not an empty coverage — while nothing can be read.
 */
let mockWalletCtx: { managers: unknown; adminOriginator: string; txStatusVersion: number }
let mockVaultPhase: string

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  useWallet: () => mockWalletCtx,
  useVault: () => ({ state: { phase: mockVaultPhase }, submitPin: () => {}, cancel: () => {}, retry: () => {} }),
  getVaultKeyCoverage: jest.fn()
}))

import { act, renderHook } from '@testing-library/react-native'
import { getVaultKeyCoverage } from '@bsv/expo-wallet-toolbox'
import { useVaultCoverage } from '../../ui/hooks/useVaultCoverage'

const fetchCoverage = getVaultKeyCoverage as jest.Mock
const COVERAGE = { outputs: 4, stale: 1, missingKeys: ['02' + 'b'.repeat(64)], removedKeyOutputs: 0 }

const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })
}

beforeEach(() => {
  fetchCoverage.mockReset()
  mockWalletCtx = { managers: { permissionsManager: {} }, adminOriginator: 'admin', txStatusVersion: 0 }
  mockVaultPhase = 'idle'
})

describe('useVaultCoverage', () => {
  test('reads on mount and again on a txStatusVersion bump', async () => {
    fetchCoverage.mockResolvedValue(COVERAGE)
    const { result, rerender } = renderHook(() => useVaultCoverage())
    expect(result.current.coverage).toBeNull()
    await settle()
    expect(result.current.coverage).toEqual(COVERAGE)
    expect(fetchCoverage).toHaveBeenCalledTimes(1)
    expect(fetchCoverage).toHaveBeenCalledWith(mockWalletCtx.managers.permissionsManager, 'admin')

    mockWalletCtx = { ...mockWalletCtx, txStatusVersion: 1 }
    rerender(undefined)
    await settle()
    expect(fetchCoverage).toHaveBeenCalledTimes(2)
  })

  test('refresh() reads again', async () => {
    fetchCoverage.mockResolvedValue(COVERAGE)
    const { result } = renderHook(() => useVaultCoverage())
    await settle()
    act(() => result.current.refresh())
    await settle()
    expect(fetchCoverage).toHaveBeenCalledTimes(2)
  })

  test.each(['preparing', 'broadcasting'])('does not read while %s, then reads once when idle again', async phase => {
    fetchCoverage.mockResolvedValue(COVERAGE)
    const { result, rerender } = renderHook(() => useVaultCoverage())
    await settle()
    expect(fetchCoverage).toHaveBeenCalledTimes(1)

    mockVaultPhase = phase
    mockWalletCtx = { ...mockWalletCtx, txStatusVersion: 1 }
    rerender(undefined)
    await settle()
    expect(fetchCoverage).toHaveBeenCalledTimes(1)
    expect(result.current.coverage).toEqual(COVERAGE)

    mockVaultPhase = 'idle'
    rerender(undefined)
    await settle()
    expect(fetchCoverage).toHaveBeenCalledTimes(2)
  })

  test('stays null with no built wallet and never calls the service', async () => {
    mockWalletCtx = { managers: { permissionsManager: null }, adminOriginator: 'admin', txStatusVersion: 0 }
    const { result } = renderHook(() => useVaultCoverage())
    await settle()
    expect(result.current.coverage).toBeNull()
    expect(fetchCoverage).not.toHaveBeenCalled()
  })

  test('keeps the last coverage when a read fails', async () => {
    fetchCoverage.mockResolvedValueOnce(COVERAGE).mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useVaultCoverage())
    await settle()
    act(() => result.current.refresh())
    await settle()
    expect(result.current.coverage).toEqual(COVERAGE)
  })

  test('ignores a read that resolves after unmount', async () => {
    let resolve!: (c: typeof COVERAGE) => void
    fetchCoverage.mockReturnValueOnce(new Promise(r => { resolve = r }))
    const { result, unmount } = renderHook(() => useVaultCoverage())
    unmount()
    await act(async () => resolve(COVERAGE))
    await settle()
    expect(result.current.coverage).toBeNull()
  })
})
