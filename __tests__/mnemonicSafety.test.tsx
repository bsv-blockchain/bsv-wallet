import React from 'react'
import { Platform } from 'react-native'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native'

const mockReplace = jest.fn()
const mockBack = jest.fn()
let mockFlow: string | undefined
let mockRestoreState: { phase: string; chunks?: number; total?: number; error?: string } = {
  phase: 'idle',
  chunks: 0,
  total: 0
}
const mockBuild = jest.fn(async (..._args: unknown[]) => {
  mockRestoreState = { phase: 'restored', chunks: 0, total: 0 }
})
const mockBuildRecovered = jest.fn(async (..._args: unknown[]) => {
  mockRestoreState = { phase: 'restored', chunks: 0, total: 0 }
})
const mockRebuild = jest.fn(async (..._args: unknown[]) => {
  mockRestoreState = { phase: 'restored', chunks: 0, total: 0 }
})
const mockCreate = jest.fn(async (_phrase: string) => true)
const mockStore = jest.fn(async (_phrase: string) => true)
const mockSetRecovered = jest.fn(async (_wif: string) => true)
const mockDeleteMnemonic = jest.fn(async () => {})
const mockDeleteRecovered = jest.fn(async () => {})
const mockHasIdentity = jest.fn(async () => false)
const mockGenerate = jest.fn(() => ({ mnemonic: 'new test phrase', identityKey: 'new-identity' }))
const mockPending = jest.fn(async (_identity: string) => {})
const mockReadMnemonic = jest.fn<Promise<string | null>, []>(async () => 'existing test phrase')
const mockReadRecovered = jest.fn<Promise<string | null>, []>(async () => null)
const mockUnlock = jest.fn(async () => ({ status: 'unlocked' }))
const mockAttest = jest.fn(async (_identity: string, _medium: string) => {})
const mockPrint = jest.fn(async (_options: unknown) => ({ ok: true }))
const mockCopy = jest.fn(async (_value: string) => true)
let mockSavedContents = ''
const mockWriteFile = jest.fn((value: string) => {
  mockSavedContents = value
})
const mockReadFile = jest.fn(async () => mockSavedContents)
const mockCreateFile = jest.fn((_filename: string, _mime: string) => ({ write: mockWriteFile, text: mockReadFile }))
const mockPickDirectory = jest.fn(async () => ({ createFile: mockCreateFile }))
const mockToast = jest.fn()
const mockShowAlert = jest.fn(async (..._args: unknown[]) => 'cancel')
let mockSecretsReady = true
let mockWalletBuilt = false
let mockWalletBuilding = false

jest.mock('expo-router', () => ({
  router: { replace: (...args: unknown[]) => mockReplace(...args), back: () => mockBack(), dismissTo: jest.fn() },
  useLocalSearchParams: () => ({ flow: mockFlow })
}))
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
jest.mock('expo-clipboard', () => ({ setStringAsync: (value: string) => mockCopy(value) }))
jest.mock('expo-file-system', () => ({ Directory: { pickDirectoryAsync: () => mockPickDirectory() } }))
jest.mock('@bsv/sdk', () => ({
  PrivateKey: {
    fromWif: () => ({
      toHex: () => 'existing-test-hex',
      toPublicKey: () => ({ toString: () => 'existing-key-identity' })
    })
  }
}))
// backupMaterial.ts (wired REAL below) imports recoverMnemonicWallet from here, and
// createWallet.ts's real orchestration is exercised through the toolbox mock's
// generate/createMnemonic path, not through this module directly.
jest.mock('../packages/expo-wallet-toolbox/core/mnemonicWallet', () => ({
  recoverMnemonicWallet: (phrase: string) => ({
    identityKey: phrase === 'existing test phrase' ? 'existing-identity' : 'new-identity'
  }),
  validateMnemonic: () => true,
  generateMnemonicWallet: () => mockGenerate()
}))
// recoveryPrompts.ts (wired REAL below, via '@bsv/expo-wallet-toolbox/ui') imports
// showAlert directly from here rather than through the (fully mocked) ui barrel.
jest.mock('../packages/expo-wallet-toolbox/ui/components/ui/AlertCard', () => ({
  showAlert: (...args: unknown[]) => mockShowAlert(...args)
}))
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  useTheme: () => ({ colors: {}, isDark: false }),
  spacing: {},
  radii: {},
  typography: { largeTitle: {}, title2: {}, title3: {}, body: {}, caption1: {} },
  useWallet: () => ({
    buildWalletFromMnemonic: mockBuild,
    backupRestore: { phase: 'idle' },
    walletBuilt: mockWalletBuilt,
    walletBuilding: mockWalletBuilding
  }),
  useLocalStorage: () => ({
    createMnemonic: mockCreate,
    setMnemonic: mockStore,
    hasStoredIdentity: mockHasIdentity,
    secretsReady: mockSecretsReady,
    getMnemonic: mockReadMnemonic,
    getRecoveredKey: mockReadRecovered,
    unlock: mockUnlock
  }),
  generateMnemonicWallet: () => mockGenerate(),
  recoverMnemonicWallet: (phrase: string) => ({
    identityKey: phrase === 'existing test phrase' ? 'existing-identity' : 'new-identity'
  }),
  backupAttestation: {
    markPending: (identity: string) => mockPending(identity),
    set: (identity: string, medium: string) => mockAttest(identity, medium)
  },
  recordBackupAttestation: jest.fn(),
  // The recovery/creation orchestration itself is the REAL module under test —
  // only its deps (below) and classifyImportInput (needs @bsv/sdk) are mocked.
  useRecoveryDeps: () => ({
    setMnemonic: mockStore,
    setRecoveredKey: mockSetRecovered,
    deleteMnemonic: mockDeleteMnemonic,
    deleteRecoveredKey: mockDeleteRecovered,
    hasStoredIdentity: mockHasIdentity,
    createMnemonic: mockCreate,
    buildWalletFromMnemonic: mockBuild,
    buildWalletFromRecoveredKey: mockBuildRecovered,
    rebuildWallet: mockRebuild,
    isWalletBuilt: () => mockWalletBuilt,
    getBackupRestore: () => mockRestoreState,
    attest: mockAttest,
    markPending: mockPending,
    generate: mockGenerate
  }),
  classifyImportInput: (text: string) => {
    const trimmed = text.trim()
    if (/^[0-9a-fA-F]{64}$/.test(trimmed))
      return { kind: 'wif', wif: 'imported-wif', identityKey: 'imported-key-identity' }
    if (trimmed === 'valid test phrase')
      return { kind: 'mnemonic', mnemonic: trimmed, identityKey: 'imported-phrase-identity' }
    return null
  },
  recoverWallet: (...args: unknown[]) =>
    jest.requireActual('../packages/expo-wallet-toolbox/core/recovery/recoverWallet').recoverWallet(...args),
  createNewWallet: (...args: unknown[]) =>
    jest.requireActual('../packages/expo-wallet-toolbox/core/recovery/createWallet').createNewWallet(...args),
  readBackupMaterial: (...args: unknown[]) =>
    jest.requireActual('../packages/expo-wallet-toolbox/core/recovery/backupMaterial').readBackupMaterial(...args)
}))
jest.mock('@bsv/expo-wallet-toolbox/ui', () => {
  const { View, Pressable, Text } = require('react-native')
  return {
    CustomSafeArea: View,
    PressableScale: Pressable,
    Celebration: () => <Text>celebration</Text>,
    showToast: (...args: unknown[]) => mockToast(...args),
    showAlert: (...args: unknown[]) => mockShowAlert(...args),
    printRecoveryShares: (options: unknown) => mockPrint(options),
    restorePrompts: (...args: unknown[]) =>
      jest.requireActual('../packages/expo-wallet-toolbox/ui/recoveryPrompts').restorePrompts(...args)
  }
})

import MnemonicScreen from '../app/auth/mnemonic'

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  jest.replaceProperty(Platform, 'OS', 'ios')
  mockSavedContents = ''
  mockCopy.mockResolvedValue(true)
  mockPrint.mockResolvedValue({ ok: true })
  mockFlow = undefined
  mockSecretsReady = true
  mockWalletBuilt = false
  mockWalletBuilding = false
  mockRestoreState = { phase: 'idle', chunks: 0, total: 0 }
  mockHasIdentity.mockResolvedValue(false)
  mockCreate.mockResolvedValue(true)
  mockStore.mockResolvedValue(true)
  mockSetRecovered.mockResolvedValue(true)
  mockReadMnemonic.mockResolvedValue('existing test phrase')
  mockReadRecovered.mockResolvedValue(null)
  mockShowAlert.mockResolvedValue('cancel')
})

afterEach(() => {
  cleanup()
  jest.clearAllTimers()
  jest.useRealTimers()
  jest.restoreAllMocks()
})

test('the backup URL displays the existing mnemonic without generating, storing, or building a wallet', async () => {
  mockFlow = 'backup'
  const screen = render(<MnemonicScreen />)
  expect(await screen.findByText('existing test phrase')).toBeTruthy()
  expect(mockReplace).not.toHaveBeenCalled()
  expect(screen.queryByText('create_new_wallet')).toBeNull()
  expect(screen.queryByText('import_existing_wallet')).toBeNull()
  expect(mockGenerate).not.toHaveBeenCalled()
  expect(mockCreate).not.toHaveBeenCalled()
  expect(mockStore).not.toHaveBeenCalled()
  expect(mockBuild).not.toHaveBeenCalled()
  expect(mockPending).not.toHaveBeenCalled()
})

test('backup waits for migration and key loading without exposing empty backup actions', async () => {
  mockFlow = 'backup'
  mockSecretsReady = false
  let finish!: (phrase: string) => void
  mockReadMnemonic.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const screen = render(<MnemonicScreen />)
  expect(mockReadMnemonic).not.toHaveBeenCalled()
  expect(screen.queryByText('copy')).toBeNull()
  mockSecretsReady = true
  screen.rerender(<MnemonicScreen />)
  await waitFor(() => expect(mockReadMnemonic).toHaveBeenCalledTimes(1))
  expect(screen.queryByText('copy')).toBeNull()
  expect(screen.queryByText('create_new_wallet')).toBeNull()
  await act(async () => {
    finish('existing test phrase')
  })
  expect(screen.getByText('existing test phrase')).toBeTruthy()
  expect(mockCreate).not.toHaveBeenCalled()
})

test.each(['missing', 'rejected'])('a %s backup read offers retry without wallet creation', async failure => {
  mockFlow = 'backup'
  if (failure === 'missing') mockReadMnemonic.mockResolvedValueOnce(null)
  else mockReadMnemonic.mockRejectedValueOnce(new Error('keychain unavailable'))
  const screen = render(<MnemonicScreen />)
  fireEvent.press(await screen.findByText('retry'))
  expect(await screen.findByText('existing test phrase')).toBeTruthy()
  expect(mockUnlock).toHaveBeenCalledTimes(1)
  expect(mockReplace).not.toHaveBeenCalled()
  expect(mockCreate).not.toHaveBeenCalled()
  expect(mockStore).not.toHaveBeenCalled()
  expect(mockBuild).not.toHaveBeenCalled()
})

test('a reused mnemonic route switches to reading the existing phrase when the backup param arrives', async () => {
  const screen = render(<MnemonicScreen />)
  await screen.findByText('create_new_wallet')
  mockFlow = 'backup'
  screen.rerender(<MnemonicScreen />)
  expect(screen.queryByText('create_new_wallet')).toBeNull()
  expect(await screen.findByText('existing test phrase')).toBeTruthy()
  expect(mockGenerate).not.toHaveBeenCalled()
})

test('a reused backup route switches to import when explicitly requested', async () => {
  mockFlow = 'backup'
  const screen = render(<MnemonicScreen />)
  await screen.findByText('existing test phrase')
  mockFlow = 'import'
  screen.rerender(<MnemonicScreen />)
  expect(await screen.findByText('restore_wallet_description')).toBeTruthy()
  expect(screen.queryByText('existing test phrase')).toBeNull()
  expect(mockGenerate).not.toHaveBeenCalled()
  expect(mockStore).not.toHaveBeenCalled()
})

test('backing up existing shares attests that identity and returns without creating a wallet', async () => {
  mockFlow = 'backup'
  const screen = render(<MnemonicScreen />)
  await screen.findByText('existing test phrase')
  await act(async () => {
    fireEvent.press(screen.getByText('print_recovery_shares'))
  })
  expect(mockPrint).toHaveBeenCalledWith({
    mnemonic: 'existing test phrase',
    recoveredKeyWif: null,
    appName: 'BSV Wallet'
  })
  expect(mockAttest).toHaveBeenCalledWith('existing-identity', 'shares')
  expect(mockBack).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.press(screen.getByText('confirm'))
  })
  expect(mockAttest).toHaveBeenCalledTimes(1)
  expect(mockBack).toHaveBeenCalledTimes(1)
  expect(mockBuild).not.toHaveBeenCalled()
  expect(mockStore).not.toHaveBeenCalled()
})

test('leaving without confirming does not record a backup', async () => {
  mockFlow = 'backup'
  const screen = render(<MnemonicScreen />)
  await screen.findByText('existing test phrase')
  screen.unmount()
  expect(mockAttest).not.toHaveBeenCalled()
})

test('hides the entire confirmation section and divider for 15 seconds without attesting', async () => {
  mockFlow = 'backup'
  const screen = render(<MnemonicScreen />)
  await act(async () => {})
  expect(screen.getByText('existing test phrase')).toBeTruthy()
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  expect(screen.queryByTestId('backup-confirmation-divider')).toBeNull()
  act(() => {
    jest.advanceTimersByTime(14_999)
  })
  expect(screen.queryByText('confirm')).toBeNull()
  act(() => {
    jest.advanceTimersByTime(1)
  })
  expect(screen.getByTestId('backup-confirmation-section')).toBeTruthy()
  expect(screen.getByTestId('backup-confirmation-divider')).toBeTruthy()
  expect(screen.getByText('confirm')).toBeTruthy()
  expect(mockAttest).not.toHaveBeenCalled()
})

test('migration and deferred key reads do not count toward the handwriting delay', async () => {
  mockFlow = 'backup'
  mockSecretsReady = false
  let finish!: (phrase: string) => void
  mockReadMnemonic.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const screen = render(<MnemonicScreen />)
  act(() => {
    jest.advanceTimersByTime(30_000)
  })
  mockSecretsReady = true
  screen.rerender(<MnemonicScreen />)
  act(() => {
    jest.advanceTimersByTime(30_000)
  })
  await act(async () => {
    finish('existing test phrase')
  })
  act(() => {
    jest.advanceTimersByTime(14_999)
  })
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  act(() => {
    jest.advanceTimersByTime(1)
  })
  expect(screen.getByText('confirm')).toBeTruthy()
  expect(mockAttest).not.toHaveBeenCalled()
})

test.each(['copy', 'save'])(
  'a successful %s immediately records the backup and reveals Confirm without navigating',
  async action => {
    mockFlow = 'backup'
    const screen = render(<MnemonicScreen />)
    await act(async () => {})
    await act(async () => {
      fireEvent.press(screen.getByText(action))
    })
    expect(mockAttest).toHaveBeenCalledWith('existing-identity', 'phrase')
    expect(screen.getByTestId('backup-confirmation-section')).toBeTruthy()
    expect(screen.getByTestId('backup-confirmation-divider')).toBeTruthy()
    expect(mockBack).not.toHaveBeenCalled()
    if (action === 'save') {
      expect(mockCreateFile).toHaveBeenCalledWith(
        expect.stringMatching(/^wallet-recovery-phrase-\d+\.txt$/),
        'text/plain'
      )
      expect(mockWriteFile).toHaveBeenCalledWith('existing test phrase')
      expect(mockReadFile).toHaveBeenCalledTimes(1)
    }
    await act(async () => {
      fireEvent.press(screen.getByText('confirm'))
    })
    expect(mockAttest).toHaveBeenCalledTimes(1)
    expect(mockBack).toHaveBeenCalledTimes(1)
  }
)

test.each([
  'copy-false',
  'copy-error',
  'save-cancelled',
  'write-failed',
  'readback-mismatch',
  'print-cancelled',
  'print-unavailable'
])('%s does not bypass the delay or record a backup', async failure => {
  mockFlow = 'backup'
  let action = 'copy'
  if (failure === 'copy-false') mockCopy.mockResolvedValueOnce(false)
  if (failure === 'copy-error') mockCopy.mockRejectedValueOnce(new Error('Clipboard unavailable'))
  if (failure === 'save-cancelled') mockPickDirectory.mockRejectedValueOnce(new Error('Cancelled'))
  if (failure === 'write-failed')
    mockWriteFile.mockImplementationOnce(() => {
      throw new Error('Write failed')
    })
  if (failure === 'readback-mismatch') mockReadFile.mockResolvedValueOnce('')
  if (['save-cancelled', 'write-failed', 'readback-mismatch'].includes(failure)) action = 'save'
  if (failure === 'print-cancelled') mockPrint.mockRejectedValueOnce(new Error('Cancelled'))
  if (failure === 'print-unavailable') mockPrint.mockResolvedValueOnce({ ok: false })
  if (failure.startsWith('print-')) action = 'print_recovery_shares'
  const screen = render(<MnemonicScreen />)
  await act(async () => {})
  await act(async () => {
    fireEvent.press(screen.getByText(action))
  })
  expect(mockAttest).not.toHaveBeenCalled()
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  expect(mockBack).not.toHaveBeenCalled()
  if (failure === 'write-failed' || failure === 'readback-mismatch') {
    expect(mockToast).toHaveBeenCalledWith('Unable to save recovery keys. Please try again.', { type: 'error' })
  } else if (failure === 'save-cancelled') {
    expect(mockToast).not.toHaveBeenCalled()
  }
})

test('a completed export with failed attestation lets Confirm retry persistence', async () => {
  mockFlow = 'backup'
  mockAttest.mockRejectedValueOnce(new Error('Storage unavailable'))
  const screen = render(<MnemonicScreen />)
  await act(async () => {})
  await act(async () => {
    fireEvent.press(screen.getByText('print_recovery_shares'))
  })
  expect(mockBack).not.toHaveBeenCalled()
  expect(mockToast).toHaveBeenCalledWith('Unable to save backup confirmation. Please try again.', { type: 'error' })
  await act(async () => {
    fireEvent.press(screen.getByText('confirm'))
  })
  expect(mockAttest).toHaveBeenNthCalledWith(2, 'existing-identity', 'shares')
  expect(mockBack).toHaveBeenCalledTimes(1)
})

test('Android printing requires Confirm because the native dialog does not report completion', async () => {
  jest.replaceProperty(Platform, 'OS', 'android')
  mockFlow = 'backup'
  const screen = render(<MnemonicScreen />)
  await act(async () => {})
  await act(async () => {
    fireEvent.press(screen.getByText('print_recovery_shares'))
  })
  expect(mockAttest).not.toHaveBeenCalled()
  expect(screen.getByText('confirm')).toBeTruthy()
  await act(async () => {
    fireEvent.press(screen.getByText('confirm'))
  })
  expect(mockAttest).toHaveBeenCalledWith('existing-identity', 'shares')
  expect(mockBack).toHaveBeenCalledTimes(1)
})

test('reentering backup resets the timer and stale Confirm handlers cannot attest', async () => {
  mockFlow = 'backup'
  const screen = render(<MnemonicScreen />)
  await act(async () => {})
  act(() => {
    jest.advanceTimersByTime(15_000)
  })
  let previousButton = screen.getByText('confirm').parent!
  while (!previousButton.props.onPress) previousButton = previousButton.parent!
  const oldConfirm = previousButton.props.onPress
  mockFlow = 'import'
  screen.rerender(<MnemonicScreen />)
  mockFlow = 'backup'
  screen.rerender(<MnemonicScreen />)
  await act(async () => {})
  await act(async () => {
    await oldConfirm()
  })
  expect(mockAttest).not.toHaveBeenCalled()
  act(() => {
    jest.advanceTimersByTime(14_999)
  })
  expect(screen.queryByText('confirm')).toBeNull()
  act(() => {
    jest.advanceTimersByTime(1)
  })
  expect(screen.getByText('confirm')).toBeTruthy()
})

test('a stale directory picker completion does not write keys or unlock a new backup session', async () => {
  mockFlow = 'backup'
  let finish!: (directory: { createFile: typeof mockCreateFile }) => void
  mockPickDirectory.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const screen = render(<MnemonicScreen />)
  await act(async () => {})
  fireEvent.press(screen.getByText('save'))
  mockFlow = 'import'
  screen.rerender(<MnemonicScreen />)
  mockFlow = 'backup'
  screen.rerender(<MnemonicScreen />)
  await act(async () => {
    finish({ createFile: mockCreateFile })
  })
  expect(mockWriteFile).not.toHaveBeenCalled()
  expect(mockAttest).not.toHaveBeenCalled()
  expect(screen.queryByText('confirm')).toBeNull()
})

test('Confirm records a manually saved phrase without requiring export or print', async () => {
  mockFlow = 'backup'
  const screen = render(<MnemonicScreen />)
  await screen.findByText('existing test phrase')
  act(() => {
    jest.advanceTimersByTime(15_000)
  })
  expect(screen.queryByText('go_back')).toBeNull()
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'confirm' }))
  })
  expect(mockAttest).toHaveBeenCalledWith('existing-identity', 'phrase')
  expect(mockBack).toHaveBeenCalledTimes(1)
  expect(mockToast).toHaveBeenCalledWith('Backup confirmed', { type: 'success' })
  expect(mockPrint).not.toHaveBeenCalled()
  expect(mockCopy).not.toHaveBeenCalled()
  expect(mockBuild).not.toHaveBeenCalled()
  expect(mockStore).not.toHaveBeenCalled()
})

test('Confirm waits for persistence and repeated taps write only once', async () => {
  mockFlow = 'backup'
  let finish!: () => void
  mockAttest.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const screen = render(<MnemonicScreen />)
  await screen.findByText('existing test phrase')
  act(() => {
    jest.advanceTimersByTime(15_000)
  })
  const confirm = screen.getByRole('button', { name: 'confirm' })
  fireEvent.press(confirm)
  fireEvent.press(confirm)
  expect(mockAttest).toHaveBeenCalledTimes(1)
  expect(mockBack).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'confirm' }).props.accessibilityState.busy).toBe(true)
  await act(async () => {
    finish()
  })
  expect(mockBack).toHaveBeenCalledTimes(1)
})

test('failed confirmation stays on the backup page and can be retried', async () => {
  mockFlow = 'backup'
  mockAttest.mockRejectedValueOnce(new Error('storage unavailable'))
  const screen = render(<MnemonicScreen />)
  await screen.findByText('existing test phrase')
  act(() => {
    jest.advanceTimersByTime(15_000)
  })
  await act(async () => {
    fireEvent.press(screen.getByText('confirm'))
  })
  expect(mockBack).not.toHaveBeenCalled()
  expect(mockToast).toHaveBeenCalledWith('Unable to save backup confirmation. Please try again.', { type: 'error' })
  await act(async () => {
    fireEvent.press(screen.getByText('confirm'))
  })
  expect(mockAttest).toHaveBeenCalledTimes(2)
  expect(mockBack).toHaveBeenCalledTimes(1)
})

test('a recovered-key wallet backs up its existing key on the same page', async () => {
  mockFlow = 'backup'
  mockReadMnemonic.mockResolvedValue(null)
  mockReadRecovered.mockResolvedValue('existing-test-wif')
  const screen = render(<MnemonicScreen />)
  expect(await screen.findByText('existing-test-hex')).toBeTruthy()
  expect(screen.queryByText('Save these words')).toBeNull()
  await act(async () => {
    fireEvent.press(screen.getByText('print_recovery_shares'))
  })
  expect(mockPrint).toHaveBeenCalledWith({
    mnemonic: null,
    recoveredKeyWif: 'existing-test-wif',
    appName: 'BSV Wallet'
  })
  await act(async () => {
    fireEvent.press(screen.getByText('confirm'))
  })
  expect(mockAttest).toHaveBeenCalledWith('existing-key-identity', 'shares')
  expect(mockGenerate).not.toHaveBeenCalled()
  expect(mockCreate).not.toHaveBeenCalled()
  expect(mockReplace).not.toHaveBeenCalled()
})

test('waits for migration and then routes an existing, still-unbuilt wallet to recovery', async () => {
  mockSecretsReady = false
  mockHasIdentity.mockResolvedValue(true)
  const screen = render(<MnemonicScreen />)
  expect(screen.queryByText('create_new_wallet')).toBeNull()
  expect(mockHasIdentity).not.toHaveBeenCalled()

  mockSecretsReady = true
  screen.rerender(<MnemonicScreen />)
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/auth/mnemonic?flow=backup'))
  expect(screen.queryByText('create_new_wallet')).toBeNull()
  expect(mockGenerate).not.toHaveBeenCalled()
  expect(mockStore).not.toHaveBeenCalled()
})

test('rechecks stored identity when creation is tapped, even without a live manager', async () => {
  const screen = render(<MnemonicScreen />)
  const create = await screen.findByText('create_new_wallet')
  mockHasIdentity.mockResolvedValue(true)
  fireEvent.press(create)
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/auth/mnemonic?flow=backup'))
  expect(mockGenerate).not.toHaveBeenCalled()
  expect(mockCreate).not.toHaveBeenCalled()
  expect(mockStore).not.toHaveBeenCalled()
})

test('a live wallet also blocks creation if its existence check is stale', async () => {
  mockWalletBuilt = true
  const screen = render(<MnemonicScreen />)
  fireEvent.press(await screen.findByText('create_new_wallet'))
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/auth/mnemonic?flow=backup'))
  expect(mockGenerate).not.toHaveBeenCalled()
  expect(mockStore).not.toHaveBeenCalled()
})

test('repeated creation taps save one phrase through the guarded API before showing it', async () => {
  let finish!: (stored: boolean) => void
  mockCreate.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const screen = render(<MnemonicScreen />)
  const create = await screen.findByText('create_new_wallet')
  fireEvent.press(create)
  fireEvent.press(create)
  await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
  expect(screen.queryByText('new test phrase')).toBeNull()
  expect(mockBuild).not.toHaveBeenCalled()
  act(() => {
    jest.advanceTimersByTime(30_000)
  })
  await act(async () => {
    finish(true)
  })
  expect(await screen.findByText('new test phrase')).toBeTruthy()
  expect(mockGenerate).toHaveBeenCalledTimes(1)
  expect(mockStore).not.toHaveBeenCalled()
  expect(mockPending).toHaveBeenCalledWith('new-identity')
  expect(mockBuild).toHaveBeenCalledWith('new test phrase')
  act(() => {
    jest.advanceTimersByTime(14_999)
  })
  expect(screen.queryByText('confirm')).toBeNull()
  act(() => {
    jest.advanceTimersByTime(1)
  })
  await act(async () => {
    fireEvent.press(screen.getByText('confirm'))
  })
  expect(mockAttest).toHaveBeenCalledWith('new-identity', 'phrase')
  expect(mockBack).not.toHaveBeenCalled()
})

test('a refused write never displays or builds the unsaved phrase', async () => {
  mockCreate.mockResolvedValue(false)
  const screen = render(<MnemonicScreen />)
  fireEvent.press(await screen.findByText('create_new_wallet'))
  await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
  expect(screen.queryByText('new test phrase')).toBeNull()
  expect(mockPending).not.toHaveBeenCalled()
  expect(mockBuild).not.toHaveBeenCalled()
  expect(mockStore).not.toHaveBeenCalled()
})

test('builds the saved wallet when pending-backup metadata cannot be written', async () => {
  mockPending.mockRejectedValueOnce(new Error('AsyncStorage unavailable'))
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const screen = render(<MnemonicScreen />)
    const create = await screen.findByText('create_new_wallet')
    await act(async () => {
      fireEvent.press(create)
      fireEvent.press(create)
    })

    expect(screen.getByText('new test phrase')).toBeTruthy()
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockBuild).toHaveBeenCalledWith('new test phrase')
    expect(mockGenerate).toHaveBeenCalledTimes(1)
    expect(mockStore).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})

test('a refused write with no existing identity toasts the new create_wallet_refused copy', async () => {
  mockCreate.mockResolvedValue(false)
  mockHasIdentity.mockResolvedValue(false)
  const screen = render(<MnemonicScreen />)
  const create = await screen.findByText('create_new_wallet')
  await act(async () => {
    fireEvent.press(create)
  })
  expect(mockToast).toHaveBeenCalledWith('create_wallet_refused', { type: 'error' })
})

test('a route flip to backup while the identity check is pending cancels quietly: nothing generated, stored, or toasted', async () => {
  const screen = render(<MnemonicScreen />)
  const create = await screen.findByText('create_new_wallet')

  // mount's own "does an identity already exist" effect already consumed the
  // first (default, immediately-resolving) call — queue the deferred
  // implementation for the SECOND call, made by createNewWallet's own guard
  // when the button below is pressed.
  let finish!: (existing: boolean) => void
  mockHasIdentity.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  fireEvent.press(create)
  await waitFor(() => expect(mockHasIdentity).toHaveBeenCalledTimes(2))

  // The route changes under the in-flight await — flowRef is refreshed on
  // render, so a rerender is needed for isBackupFlow() to see it.
  mockFlow = 'backup'
  screen.rerender(<MnemonicScreen />)

  await act(async () => {
    finish(false)
  })

  expect(mockGenerate).not.toHaveBeenCalled()
  expect(mockCreate).not.toHaveBeenCalled()
  expect(mockToast).not.toHaveBeenCalled()
  expect(mockReplace).not.toHaveBeenCalled()
  expect(screen.queryByText('new test phrase')).toBeNull()
})

describe('import flow', () => {
  const HEX_KEY = 'a'.repeat(64)

  const renderImport = async () => {
    mockFlow = 'import'
    const screen = render(<MnemonicScreen />)
    const input = await screen.findByPlaceholderText('enter_recovery_words')
    return { screen, input }
  }

  // Two elements carry the literal 'import_wallet' text in this mode: the
  // heading and the continue button — the button is always the second.
  const pressContinue = (screen: ReturnType<typeof render>) => {
    fireEvent.press(screen.getAllByText('import_wallet')[1])
  }

  test('hex import stores the recovered key, deletes the mnemonic, builds, attests, and celebrates', async () => {
    const { screen, input } = await renderImport()
    fireEvent.changeText(input, HEX_KEY)
    await act(async () => {
      pressContinue(screen)
    })

    expect(mockSetRecovered).toHaveBeenCalledWith('imported-wif')
    expect(mockDeleteMnemonic).toHaveBeenCalled()
    expect(mockSetRecovered.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteMnemonic.mock.invocationCallOrder[0])
    expect(mockBuildRecovered).toHaveBeenCalledWith('imported-wif', { restoreFromBackup: true })
    expect(mockAttest).toHaveBeenCalledWith('imported-key-identity', 'phrase')
    expect(screen.getByText('celebration')).toBeTruthy()
  })

  test('hex import while the wallet is already built rebuilds instead of building fresh', async () => {
    mockWalletBuilt = true
    const { screen, input } = await renderImport()
    fireEvent.changeText(input, HEX_KEY)
    await act(async () => {
      pressContinue(screen)
    })

    expect(mockRebuild).toHaveBeenCalledWith({ restoreFromBackup: true })
    expect(mockBuildRecovered).not.toHaveBeenCalled()
    expect(screen.getByText('celebration')).toBeTruthy()
  })

  test('mnemonic import stores the phrase, deletes the recovered key, builds, and attests', async () => {
    const { screen, input } = await renderImport()
    fireEvent.changeText(input, 'valid test phrase')
    await act(async () => {
      pressContinue(screen)
    })

    expect(mockStore).toHaveBeenCalledWith('valid test phrase')
    expect(mockDeleteRecovered).toHaveBeenCalled()
    expect(mockStore.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteRecovered.mock.invocationCallOrder[0])
    expect(mockBuild).toHaveBeenCalledWith('valid test phrase', { restoreFromBackup: true })
    expect(mockAttest).toHaveBeenCalledWith('imported-phrase-identity', 'phrase')
    expect(screen.getByText('celebration')).toBeTruthy()
  })

  test('a refused store builds and attests nothing, and shows no celebration', async () => {
    mockStore.mockResolvedValueOnce(false)
    mockShowAlert.mockResolvedValueOnce('cancel')
    const { screen, input } = await renderImport()
    fireEvent.changeText(input, 'valid test phrase')
    await act(async () => {
      pressContinue(screen)
    })

    expect(mockBuild).not.toHaveBeenCalled()
    expect(mockAttest).not.toHaveBeenCalled()
    expect(screen.queryByText('celebration')).toBeNull()
  })

  test('a failed restore, skipped at the prompt, rebuilds without history and celebrates (hex)', async () => {
    mockBuildRecovered.mockImplementationOnce(async () => {
      mockRestoreState = { phase: 'failed', error: 'boom' }
    })
    mockShowAlert.mockResolvedValueOnce('skip')
    const { screen, input } = await renderImport()
    fireEvent.changeText(input, HEX_KEY)
    await act(async () => {
      pressContinue(screen)
    })

    expect(mockBuildRecovered).toHaveBeenCalledTimes(2)
    expect(mockBuildRecovered).toHaveBeenNthCalledWith(2, 'imported-wif', { restoreFromBackup: false })
    expect(mockAttest).toHaveBeenCalledTimes(1)
    expect(screen.getByText('celebration')).toBeTruthy()
  })

  test('a failed restore, skipped at the prompt, rebuilds without history and celebrates (mnemonic)', async () => {
    mockBuild.mockImplementationOnce(async () => {
      mockRestoreState = { phase: 'failed', error: 'boom' }
    })
    mockShowAlert.mockResolvedValueOnce('skip')
    const { screen, input } = await renderImport()
    fireEvent.changeText(input, 'valid test phrase')
    await act(async () => {
      pressContinue(screen)
    })

    expect(mockBuild).toHaveBeenCalledTimes(2)
    expect(mockBuild).toHaveBeenNthCalledWith(2, 'valid test phrase', { restoreFromBackup: false })
    expect(mockAttest).toHaveBeenCalledTimes(1)
    expect(screen.getByText('celebration')).toBeTruthy()
  })

  test('a failed restore, retried at the prompt, stops after one build with a toast and no celebration', async () => {
    mockBuildRecovered.mockImplementationOnce(async () => {
      mockRestoreState = { phase: 'failed', error: 'boom' }
    })
    mockShowAlert.mockResolvedValueOnce('retry')
    const { screen, input } = await renderImport()
    fireEvent.changeText(input, HEX_KEY)
    await act(async () => {
      pressContinue(screen)
    })

    expect(mockBuildRecovered).toHaveBeenCalledTimes(1)
    expect(mockAttest).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith('restore_backup_failed_title', { type: 'error' })
    expect(screen.queryByText('celebration')).toBeNull()
  })

  test('a route flip to backup mid-restore guards the outcome: no celebration, no toast, and the backup screen still reaches Confirm', async () => {
    const { screen, input } = await renderImport()
    fireEvent.changeText(input, 'valid test phrase')
    // The route changes while `recoverWallet` is still in flight — flowRef is
    // refreshed on render, so a rerender (triggered here, from inside the
    // awaited build) is needed for the post-await isBackupFlow() check below
    // to see it.
    mockBuild.mockImplementationOnce(async () => {
      mockRestoreState = { phase: 'restored', chunks: 0, total: 0 }
      mockFlow = 'backup'
      screen.rerender(<MnemonicScreen />)
    })
    await act(async () => {
      pressContinue(screen)
    })

    // The celebration overlay is already gated on `!isBackup`, so it staying
    // hidden here doesn't by itself prove the guard fired — an un-guarded
    // `setCelebrating(true)` is invisible there but NOT invisible in
    // `backupSession`'s own memo, which returns null while `celebrating` is
    // true regardless of flow. That leak would permanently hide the backup
    // screen's Confirm section, so reaching it is the real pin.
    expect(screen.queryByText('celebration')).toBeNull()
    expect(mockToast).not.toHaveBeenCalled()
    await screen.findByText('existing test phrase')
    act(() => {
      jest.advanceTimersByTime(15_000)
    })
    expect(screen.getByTestId('backup-confirmation-section')).toBeTruthy()
  })

  test('an existing identity asks to confirm the replace; declining stores nothing (P1-7 layer 2)', async () => {
    mockHasIdentity.mockResolvedValue(true)
    mockShowAlert.mockResolvedValue('cancel')
    const { screen, input } = await renderImport()
    fireEvent.changeText(input, 'valid test phrase')
    await act(async () => {
      pressContinue(screen)
    })

    expect(mockShowAlert).toHaveBeenCalledWith(expect.objectContaining({ title: 'recovery_replace_wallet_title' }))
    expect(mockStore).not.toHaveBeenCalled()
    expect(mockSetRecovered).not.toHaveBeenCalled()
    expect(mockBuild).not.toHaveBeenCalled()
    expect(screen.queryByText('celebration')).toBeNull()
  })

  test('invalid input shows the invalid-input alert without storing anything', async () => {
    const { screen, input } = await renderImport()
    fireEvent.changeText(input, 'not a phrase')
    await act(async () => {
      pressContinue(screen)
    })

    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'import_invalid_input_title', message: 'import_invalid_input_message' })
    )
    expect(mockStore).not.toHaveBeenCalled()
    expect(mockSetRecovered).not.toHaveBeenCalled()
  })
})
