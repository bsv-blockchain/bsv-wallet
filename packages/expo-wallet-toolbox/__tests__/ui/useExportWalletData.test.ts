/**
 * The export action shared by Settings and the Vault screen: one in-flight
 * export at a time, a spinner flag while it runs, failures swallowed (the OS
 * share sheet being dismissed is not an error worth a red line).
 */
let mockStorage: unknown = { dbName: 'wallet-0f7ae53f-mainnet-1788405945.db' }
const mockExport = jest.fn()

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  useWallet: () => ({ storage: mockStorage })
}))
jest.mock('../../ui/exportDatabases', () => ({
  exportAllWalletDatabases: (...args: unknown[]) => mockExport(...args)
}))

import { act, renderHook } from '@testing-library/react-native'
import { useExportWalletData } from '../../ui/hooks/useExportWalletData'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  mockExport.mockReset()
  mockStorage = { dbName: 'wallet-0f7ae53f-mainnet-1788405945.db' }
})

describe('useExportWalletData', () => {
  test('exports the current storage and exposes the in-flight state', async () => {
    const first = deferred<number>()
    mockExport.mockReturnValueOnce(first.promise)
    const { result } = renderHook(() => useExportWalletData())
    expect(result.current.exporting).toBe(false)

    let run!: Promise<void>
    act(() => {
      run = result.current.exportData()
    })
    expect(result.current.exporting).toBe(true)
    expect(mockExport).toHaveBeenCalledTimes(1)
    expect(mockExport).toHaveBeenCalledWith(mockStorage)

    await act(async () => {
      first.resolve(1)
      await run
    })
    expect(result.current.exporting).toBe(false)
  })

  test('ignores a second tap while an export is in flight', async () => {
    const first = deferred<number>()
    mockExport.mockReturnValueOnce(first.promise)
    const { result } = renderHook(() => useExportWalletData())

    let a!: Promise<void>
    let b!: Promise<void>
    act(() => {
      a = result.current.exportData()
      b = result.current.exportData()
    })
    expect(mockExport).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve(1)
      await Promise.all([a, b])
    })
    expect(result.current.exporting).toBe(false)
  })

  test('swallows a failed export and clears the spinner', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockExport.mockRejectedValueOnce(new Error('share sheet dismissed'))
    const { result } = renderHook(() => useExportWalletData())
    await act(async () => {
      await result.current.exportData()
    })
    expect(result.current.exporting).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  test('passes a null storage through (exportAllWalletDatabases returns 0 for it)', async () => {
    mockStorage = null
    mockExport.mockResolvedValueOnce(0)
    const { result } = renderHook(() => useExportWalletData())
    await act(async () => {
      await result.current.exportData()
    })
    expect(mockExport).toHaveBeenCalledWith(null)
  })
})
