/**
 * useRecoveryDeps — wires RestoreWalletDeps & CreateWalletDeps to the real
 * providers. Every field is a straight forward: this test proves each one
 * reaches the right underlying function with the right arguments.
 */
const mockSetMnemonic = jest.fn(async (_m: string) => true)
const mockSetRecoveredKey = jest.fn(async (_w: string) => true)
const mockDeleteMnemonic = jest.fn(async () => {})
const mockDeleteRecoveredKey = jest.fn(async () => {})
const mockHasStoredIdentity = jest.fn(async () => false)
const mockCreateMnemonic = jest.fn(async (_m: string) => true)

const mockBuildWalletFromMnemonic = jest.fn(async () => {})
const mockBuildWalletFromRecoveredKey = jest.fn(async () => {})
const mockRebuildWallet = jest.fn(async () => {})
const mockGetWalletBuilt = jest.fn(() => false)
const mockGetBackupRestore = jest.fn(() => ({ phase: 'idle' as const }))

const mockAttestSet = jest.fn(async (_k: string, _m: string) => {})
const mockMarkPending = jest.fn(async (_k: string) => {})

const mockGenerate = jest.fn(() => ({ mnemonic: 'generated phrase', identityKey: 'id-generated' }))

jest.mock('../../core/context/WalletContext', () => ({
  useWallet: () => ({
    buildWalletFromMnemonic: mockBuildWalletFromMnemonic,
    buildWalletFromRecoveredKey: mockBuildWalletFromRecoveredKey,
    rebuildWallet: mockRebuildWallet,
    getWalletBuilt: mockGetWalletBuilt,
    getBackupRestore: mockGetBackupRestore
  })
}))

jest.mock('../../core/context/LocalStorageProvider', () => ({
  useLocalStorage: () => ({
    setMnemonic: mockSetMnemonic,
    setRecoveredKey: mockSetRecoveredKey,
    deleteMnemonic: mockDeleteMnemonic,
    deleteRecoveredKey: mockDeleteRecoveredKey,
    hasStoredIdentity: mockHasStoredIdentity,
    createMnemonic: mockCreateMnemonic
  })
}))

// Wrapped in indirection functions, not referenced directly: this factory
// (like every jest.mock factory) is invoked while requires are still being
// hoisted, BEFORE the `const mock* = jest.fn(...)` statements above have
// run — capturing `mockAttestSet` by value here would bake in `undefined`.
// A closure that calls through to it lazily, at actual invocation time
// (well after module-init), sidesteps that.
jest.mock('../../core/services/vault/backupAttestation', () => ({
  backupAttestation: {
    set: (...args: [string, string]) => mockAttestSet(...args),
    markPending: (...args: [string]) => mockMarkPending(...args)
  }
}))

jest.mock('../../core/mnemonicWallet', () => ({
  generateMnemonicWallet: (...args: []) => mockGenerate(...args)
}))

import { renderHook } from '@testing-library/react-native'
import { useRecoveryDeps } from '../../core/recovery/useRecoveryDeps'

describe('useRecoveryDeps', () => {
  beforeEach(() => jest.clearAllMocks())

  test('setMnemonic forwards to useLocalStorage().setMnemonic', async () => {
    const { result } = renderHook(() => useRecoveryDeps())
    await result.current.setMnemonic('x')
    expect(mockSetMnemonic).toHaveBeenCalledWith('x')
  })

  test('setRecoveredKey forwards to useLocalStorage().setRecoveredKey', async () => {
    const { result } = renderHook(() => useRecoveryDeps())
    await result.current.setRecoveredKey('wif')
    expect(mockSetRecoveredKey).toHaveBeenCalledWith('wif')
  })

  test('deleteMnemonic / deleteRecoveredKey forward', async () => {
    const { result } = renderHook(() => useRecoveryDeps())
    await result.current.deleteMnemonic()
    await result.current.deleteRecoveredKey()
    expect(mockDeleteMnemonic).toHaveBeenCalled()
    expect(mockDeleteRecoveredKey).toHaveBeenCalled()
  })

  test('hasStoredIdentity / createMnemonic forward', async () => {
    const { result } = renderHook(() => useRecoveryDeps())
    await result.current.hasStoredIdentity()
    await result.current.createMnemonic('phrase')
    expect(mockHasStoredIdentity).toHaveBeenCalled()
    expect(mockCreateMnemonic).toHaveBeenCalledWith('phrase')
  })

  test('buildWalletFromMnemonic / buildWalletFromRecoveredKey / rebuildWallet forward', async () => {
    const { result } = renderHook(() => useRecoveryDeps())
    await result.current.buildWalletFromMnemonic('m', { restoreFromBackup: true })
    await result.current.buildWalletFromRecoveredKey('w', { restoreFromBackup: false })
    await result.current.rebuildWallet({ restoreFromBackup: true })
    expect(mockBuildWalletFromMnemonic).toHaveBeenCalledWith('m', { restoreFromBackup: true })
    expect(mockBuildWalletFromRecoveredKey).toHaveBeenCalledWith('w', { restoreFromBackup: false })
    expect(mockRebuildWallet).toHaveBeenCalledWith({ restoreFromBackup: true })
  })

  test('isWalletBuilt = getWalletBuilt from the wallet context', () => {
    mockGetWalletBuilt.mockReturnValue(true)
    const { result } = renderHook(() => useRecoveryDeps())
    expect(result.current.isWalletBuilt()).toBe(true)
    expect(mockGetWalletBuilt).toHaveBeenCalled()
  })

  test('getBackupRestore forwards', () => {
    const { result } = renderHook(() => useRecoveryDeps())
    result.current.getBackupRestore()
    expect(mockGetBackupRestore).toHaveBeenCalled()
  })

  test('attest(k, "phrase") calls backupAttestation.set(k, "phrase")', async () => {
    const { result } = renderHook(() => useRecoveryDeps())
    await result.current.attest('id-key', 'phrase')
    expect(mockAttestSet).toHaveBeenCalledWith('id-key', 'phrase')
  })

  test('markPending forwards to backupAttestation.markPending', async () => {
    const { result } = renderHook(() => useRecoveryDeps())
    await result.current.markPending('id-key')
    expect(mockMarkPending).toHaveBeenCalledWith('id-key')
  })

  test('generate = generateMnemonicWallet', () => {
    const { result } = renderHook(() => useRecoveryDeps())
    const w = result.current.generate()
    expect(mockGenerate).toHaveBeenCalled()
    expect(w).toEqual({ mnemonic: 'generated phrase', identityKey: 'id-generated' })
  })

  test('memoises the deps object across re-renders when its inputs are stable', () => {
    const { result, rerender } = renderHook(() => useRecoveryDeps())
    const first = result.current
    rerender({})
    expect(result.current).toBe(first)
  })
})
