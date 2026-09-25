/**
 * The export action shared by Settings and the Vault screen: one in-flight
 * export at a time, a spinner flag while it runs, failures swallowed (the OS
 * share sheet being dismissed is not an error worth a red line).
 *
 * XR-086: exportAllWalletDatabases() hands a raw, unencrypted SQLite image
 * (identity keys, certificate fields, transaction/derivation metadata,
 * contacts — see core/storage/schema/createTables.ts; no mnemonic/seed lives
 * in this schema) straight to the OS share sheet. Full at-rest encryption
 * needs a product decision this row cannot make unilaterally (how would the
 * *importing* device get the passphrase/key back?) — recorded as a design
 * delta on XR-086. What this file locks is the half that needs no such
 * decision: the export's contents and risk must be made explicit, and the
 * user must be able to back out, before any bytes are written or shared.
 */
let mockStorage: unknown = { dbName: 'wallet-0f7ae53f-mainnet-1788405945.db' }
const mockExport = jest.fn()
let mockAlertChoice = 'export'
const mockShowAlert = jest.fn(async (..._args: unknown[]) => mockAlertChoice)

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  useWallet: () => ({ storage: mockStorage }),
  i18n: { t: (key: string) => key }
}))
jest.mock('../../ui/exportDatabases', () => ({
  exportAllWalletDatabases: (...args: unknown[]) => mockExport(...args)
}))
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: (...a: unknown[]) => mockShowAlert(...a) }))

import { act, renderHook } from '@testing-library/react-native'
import { useExportWalletData } from '../../ui/hooks/useExportWalletData'

/** Flushes a real macrotask, not just one microtask — `await showAlert(...)`
 * needs more than a single `Promise.resolve()` tick to actually settle and
 * run its continuation (the mock alert is itself an async function, so
 * resolving it and then firing exportData's `.then` each cost a tick). */
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
  mockShowAlert.mockClear()
  mockAlertChoice = 'export'
  mockStorage = { dbName: 'wallet-0f7ae53f-mainnet-1788405945.db' }
})

describe('useExportWalletData', () => {
  test('shows the unencrypted-export warning, in order, before exporting — and proceeds once confirmed', async () => {
    const first = deferred<number>()
    mockExport.mockReturnValueOnce(first.promise)
    const { result } = renderHook(() => useExportWalletData())

    let run!: Promise<void>
    act(() => {
      run = result.current.exportData()
    })
    await flush()

    expect(mockShowAlert).toHaveBeenCalledTimes(1)
    expect(mockExport).toHaveBeenCalledTimes(1)
    // The warning is resolved (confirmed) strictly before the export call.
    expect(mockShowAlert.mock.invocationCallOrder[0]).toBeLessThan(mockExport.mock.invocationCallOrder[0])

    await act(async () => {
      first.resolve(1)
      await run
    })
    expect(mockExport).toHaveBeenCalledWith(mockStorage)
  })

  test('never exports, and never sets the in-flight flag, when the warning is dismissed', async () => {
    mockAlertChoice = 'cancel'
    const { result } = renderHook(() => useExportWalletData())

    await act(async () => {
      await result.current.exportData()
    })

    expect(mockShowAlert).toHaveBeenCalledTimes(1)
    expect(mockExport).not.toHaveBeenCalled()
    expect(result.current.exporting).toBe(false)
  })

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

    await flush()
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
    // The second call must never even reach the confirmation dialog.
    expect(mockShowAlert).toHaveBeenCalledTimes(1)

    await flush()
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
