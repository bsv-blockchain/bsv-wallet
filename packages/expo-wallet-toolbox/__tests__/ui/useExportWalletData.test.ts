/**
 * The export action shared by Settings and the Vault screen: one in-flight
 * export at a time, a spinner flag while it runs, failures swallowed (the OS
 * share sheet being dismissed is not an error worth a red line).
 *
 * XR-086: the export is encrypted to the wallet by default; `encrypt: false`
 * still writes the raw SQLite image for development. The confirmation alert
 * that used to precede it was removed by product decision, so a tap goes
 * straight to the share sheet.
 */
let mockStorage: unknown = { dbName: 'wallet-0f7ae53f-mainnet-1788405945.db' }
const mockExport = jest.fn()
const mockPermissionsManager = { encrypt: jest.fn() }
const encrypted = { encrypt: true, wallet: mockPermissionsManager, originator: 'admin.test' }

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  useWallet: () => ({
    storage: mockStorage,
    managers: { permissionsManager: mockPermissionsManager },
    adminOriginator: 'admin.test'
  })
}))
const mockShowToast = jest.fn()
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: (...a: unknown[]) => mockShowToast(...a) }))
jest.mock('../../ui/exportDatabases', () => ({
  exportAllWalletDatabases: (...args: unknown[]) => mockExport(...args)
}))

import { act, renderHook } from '@testing-library/react-native'
import { useExportWalletData } from '../../ui/hooks/useExportWalletData'

/** Flushes a real macrotask so the export call and state updates settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

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
  test('exports the current storage straight away, with no confirmation step, and exposes the in-flight state', async () => {
    const first = deferred<number>()
    mockExport.mockReturnValueOnce(first.promise)
    const { result } = renderHook(() => useExportWalletData())
    expect(result.current.exporting).toBe(false)

    let run!: Promise<void>
    act(() => {
      run = result.current.exportData()
    })
    await flush()
    expect(result.current.exporting).toBe(true)
    expect(mockExport).toHaveBeenCalledTimes(1)
    expect(mockExport).toHaveBeenCalledWith(mockStorage, encrypted)

    await act(async () => {
      first.resolve(1)
      await run
    })
    expect(result.current.exporting).toBe(false)
  })

  test('can export again once the previous export has finished', async () => {
    mockExport.mockResolvedValue(1)
    const { result } = renderHook(() => useExportWalletData())
    await act(async () => {
      await result.current.exportData()
    })
    await act(async () => {
      await result.current.exportData()
    })
    expect(mockExport).toHaveBeenCalledTimes(2)
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
    await flush()
    expect(mockExport).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve(1)
      await Promise.all([a, b])
    })
    expect(result.current.exporting).toBe(false)
  })

  test('reports a failed export as an error toast and clears the spinner', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockExport.mockRejectedValueOnce(new Error('snapshot refused'))
    const { result } = renderHook(() => useExportWalletData())
    await act(async () => {
      await result.current.exportData()
    })
    expect(result.current.exporting).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(mockShowToast).toHaveBeenCalledWith('snapshot refused', { type: 'error' })
    warn.mockRestore()
  })

  test('passes a null storage through (exportAllWalletDatabases returns 0 for it)', async () => {
    mockStorage = null
    mockExport.mockResolvedValueOnce(0)
    const { result } = renderHook(() => useExportWalletData())
    await act(async () => {
      await result.current.exportData()
    })
    expect(mockExport).toHaveBeenCalledWith(null, encrypted)
  })

  test('encrypt: false exports the raw image, with no wallet handed over', async () => {
    mockExport.mockResolvedValueOnce(1)
    const { result } = renderHook(() => useExportWalletData())
    await act(async () => {
      await result.current.exportData({ encrypt: false })
    })
    expect(mockExport).toHaveBeenCalledWith(mockStorage, {})
  })
})
