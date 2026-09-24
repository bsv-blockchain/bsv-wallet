/**
 * app/auth/scan-shares.tsx — the QR-scan side of wallet recovery. Drives the
 * screen through the pure `collectShare` reducer and the real `recoverWallet`
 * retry policy (both required via `jest.requireActual`, relative paths, and
 * wired into the mocked '@bsv/expo-wallet-toolbox' package below), against
 * mocked `useRecoveryDeps` functions. `@bsv/sdk` is NOT mocked in this file —
 * `secretFromShares` and the fixture generators (`generateEntropyShares`,
 * `generateLegacyKeyShares`, `generateMnemonicWallet`) are the real,
 * sdk-backed implementations, so the shares scanned here recombine exactly
 * like production shares would.
 */
import React from 'react'
import { act, render, waitFor } from '@testing-library/react-native'
import { generateEntropyShares, generateLegacyKeyShares } from '../packages/expo-wallet-toolbox/core/recovery/shares'
import { generateMnemonicWallet, recoverMnemonicWallet } from '../packages/expo-wallet-toolbox/core/mnemonicWallet'
import { Mnemonic, PrivateKey } from '@bsv/sdk'
import ScanSharesScreen from '../app/auth/scan-shares'

const mockBack = jest.fn()
const mockDismissTo = jest.fn()

const mockSetMnemonic = jest.fn(async (_m: string) => true)
const mockSetRecoveredKey = jest.fn(async (_wif: string) => true)
const mockDeleteMnemonic = jest.fn(async () => {})
const mockDeleteRecoveredKey = jest.fn(async () => {})
const mockBuild = jest.fn(async (_m: string, _opts?: unknown) => {})
const mockBuildRecovered = jest.fn(async (_wif: string, _opts?: unknown) => {})
const mockRebuild = jest.fn(async (_opts?: unknown) => {})
const mockAttest = jest.fn(async (_identity: string, _medium: string) => {})
const mockHapticSuccess = jest.fn()
const mockHapticError = jest.fn()
const mockShowAlert = jest.fn(async (_options: unknown) => 'ok')

// Wraps the real secretFromShares by default (below), so tests can force a
// throw from it (mockImplementationOnce) without disturbing the real
// recombination other tests rely on.
const mockSecretFromShares = jest.fn((shareStrings: string[]) =>
  jest.requireActual('../packages/expo-wallet-toolbox/core/recovery/secret').secretFromShares(shareStrings)
)

const mockHasStoredIdentity = jest.fn(async () => false)
let mockWalletBuilt = false
let mockRestoreState: { phase: string; error?: string; verified?: boolean } = { phase: 'idle' }
let mockBackupRestore: { phase: string; chunks: number; total: number } = { phase: 'idle', chunks: 0, total: 0 }

// Set by the mocked QRScanner whenever the screen (re)renders it, so tests
// can drive scans with `act(() => mockOnScan(raw))`.
let mockOnScan: (data: string) => void

jest.mock('expo-router', () => ({
  router: {
    back: (...args: unknown[]) => mockBack(...args),
    dismissTo: (...args: unknown[]) => mockDismissTo(...args),
    replace: jest.fn()
  }
}))
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
jest.mock('react-i18next', () => ({
  // Interpolation-aware so progress/threshold counts are visible in rendered
  // text — plain identity (no params) still matches the literal key.
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key)
  })
}))

jest.mock('@bsv/expo-wallet-toolbox', () => {
  const { collectShare, emptyShareCollection } = jest.requireActual(
    '../packages/expo-wallet-toolbox/core/recovery/shareCollector'
  )
  const { recoverWallet } = jest.requireActual('../packages/expo-wallet-toolbox/core/recovery/recoverWallet')

  return {
    useTheme: () => ({ colors: {}, isDark: false }),
    spacing: {},
    radii: {},
    typography: { headline: {}, subhead: {}, footnote: {} },
    useWallet: () => ({ backupRestore: mockBackupRestore }),
    useRecoveryDeps: () => ({
      setMnemonic: mockSetMnemonic,
      setRecoveredKey: mockSetRecoveredKey,
      deleteMnemonic: mockDeleteMnemonic,
      deleteRecoveredKey: mockDeleteRecoveredKey,
      buildWalletFromMnemonic: mockBuild,
      buildWalletFromRecoveredKey: mockBuildRecovered,
      rebuildWallet: mockRebuild,
      isWalletBuilt: () => mockWalletBuilt,
      getBackupRestore: () => mockRestoreState,
      attest: mockAttest,
      markPending: jest.fn(),
      generate: jest.fn(),
      hasStoredIdentity: mockHasStoredIdentity,
      createMnemonic: jest.fn(async () => true)
    }),
    haptics: {
      success: (...args: unknown[]) => mockHapticSuccess(...args),
      error: (...args: unknown[]) => mockHapticError(...args)
    },
    collectShare,
    emptyShareCollection,
    // Wrapped (not assigned directly): the outer `mockSecretFromShares` isn't
    // initialized yet when this factory itself runs (module setup order), so
    // the reference has to be resolved lazily, on each call, same as the
    // `haptics` functions below.
    secretFromShares: (shareStrings: string[]) => mockSecretFromShares(shareStrings),
    recoverWallet
  }
})

jest.mock('@bsv/expo-wallet-toolbox/ui', () => {
  const { View, Text } = require('react-native')
  const restorePrompts = jest.requireActual('../packages/expo-wallet-toolbox/ui/recoveryPrompts').restorePrompts
  return {
    QRScanner: (props: { onScan: (d: string) => void; hintText?: string; renderBottom?: () => React.ReactNode }) => {
      mockOnScan = props.onScan
      return (
        <View>
          {props.hintText ? <Text>{props.hintText}</Text> : null}
          {props.renderBottom ? props.renderBottom() : null}
        </View>
      )
    },
    Celebration: () => <Text>celebration</Text>,
    showAlert: (options: unknown) => mockShowAlert(options),
    restorePrompts
  }
})

// `restorePrompts` (required actual above) imports `showAlert` from this
// relative path — intercepting it here routes the retry/skip dialogs through
// the same `mockShowAlert` the legacy-notice alert uses.
jest.mock('../packages/expo-wallet-toolbox/ui/components/ui/AlertCard', () => ({
  showAlert: (options: unknown) => mockShowAlert(options)
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockWalletBuilt = false
  mockRestoreState = { phase: 'idle' }
  mockBackupRestore = { phase: 'idle', chunks: 0, total: 0 }
  mockSetMnemonic.mockResolvedValue(true)
  mockSetRecoveredKey.mockResolvedValue(true)
  mockHasStoredIdentity.mockResolvedValue(false)
  mockShowAlert.mockResolvedValue('ok')
})

afterEach(() => {
  jest.restoreAllMocks()
})

function scanAll(shares: string[]) {
  return act(async () => {
    for (const s of shares) mockOnScan(s)
  })
}

describe('scan-shares screen', () => {
  test('a complete 2-of-3 entropy set recovers a mnemonic wallet', async () => {
    const { mnemonic, identityKey } = generateMnemonicWallet()
    const entropy = Mnemonic.fromString(mnemonic).toEntropy()
    const shares = generateEntropyShares(entropy)

    render(<ScanSharesScreen />)
    await scanAll(shares.slice(0, 2))

    await waitFor(() => expect(mockSetMnemonic).toHaveBeenCalledWith(mnemonic))
    expect(mockDeleteRecoveredKey).toHaveBeenCalledTimes(1)
    expect(mockSetMnemonic.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteRecoveredKey.mock.invocationCallOrder[0])
    expect(mockBuild).toHaveBeenCalledWith(mnemonic, { restoreFromBackup: true })
    expect(mockAttest).toHaveBeenCalledWith(identityKey, 'shares')
    expect(identityKey).toBe(recoverMnemonicWallet(mnemonic).identityKey)
    expect(mockShowAlert).not.toHaveBeenCalled()
  })

  test('a legacy 2-of-3 key set recovers a WIF wallet and shows the legacy notice before celebrating', async () => {
    const key = PrivateKey.fromRandom()
    const shares = generateLegacyKeyShares(Array.from(key.toArray()))
    const wif = key.toWif()
    const pubkey = key.toPublicKey().toString()

    // Held open so the intermediate (alert shown, not yet celebrating) state
    // is actually observable rather than racing past it in one microtask.
    let resolveAlert!: (value: string) => void
    mockShowAlert.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          resolveAlert = resolve
        })
    )

    const screen = render(<ScanSharesScreen />)
    await scanAll(shares.slice(0, 2))

    await waitFor(() => expect(mockSetRecoveredKey).toHaveBeenCalledWith(wif))
    expect(mockDeleteMnemonic).toHaveBeenCalledTimes(1)
    expect(mockSetRecoveredKey.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteMnemonic.mock.invocationCallOrder[0])
    expect(mockBuildRecovered).toHaveBeenCalledWith(wif, { restoreFromBackup: true })
    expect(mockShowAlert).toHaveBeenCalledWith(expect.objectContaining({ title: 'scan_shares_legacy_title' }))

    // The legacy alert is still open — celebration must wait for it, even
    // though attestation (part of restoreWallet's own flow) already ran.
    expect(screen.queryByText('celebration')).toBeNull()
    expect(mockAttest).toHaveBeenCalledWith(pubkey, 'shares')

    await act(async () => resolveAlert('ok'))
    expect(screen.getByText('celebration')).toBeTruthy()
  })

  test('a restore that completed but could not be verified shows the unverified alert, then celebrates', async () => {
    mockRestoreState = { phase: 'restored', verified: false }
    const { mnemonic } = generateMnemonicWallet()
    const entropy = Mnemonic.fromString(mnemonic).toEntropy()
    const shares = generateEntropyShares(entropy)

    const screen = render(<ScanSharesScreen />)
    await scanAll(shares.slice(0, 2))

    await waitFor(() =>
      expect(mockShowAlert).toHaveBeenCalledWith({
        title: 'restore_backup_unverified_title',
        message: 'restore_backup_unverified_body',
        buttons: [{ text: 'dismiss', key: 'dismiss' }]
      })
    )
    expect(screen.getByText('celebration')).toBeTruthy()
  })

  test('a fully verified restore never shows the unverified alert', async () => {
    mockRestoreState = { phase: 'restored', verified: true }
    const { mnemonic } = generateMnemonicWallet()
    const entropy = Mnemonic.fromString(mnemonic).toEntropy()
    const shares = generateEntropyShares(entropy)

    const screen = render(<ScanSharesScreen />)
    await scanAll(shares.slice(0, 2))

    await waitFor(() => expect(screen.getByText('celebration')).toBeTruthy())
    expect(mockShowAlert).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'restore_backup_unverified_title' })
    )
  })

  test('an already-built wallet rebuilds instead of building fresh', async () => {
    mockWalletBuilt = true
    const { mnemonic } = generateMnemonicWallet()
    const entropy = Mnemonic.fromString(mnemonic).toEntropy()
    const shares = generateEntropyShares(entropy)

    render(<ScanSharesScreen />)
    await scanAll(shares.slice(0, 2))

    await waitFor(() => expect(mockRebuild).toHaveBeenCalledWith({ restoreFromBackup: true }))
    expect(mockBuild).not.toHaveBeenCalled()
  })

  // NOTE: `collectShare`'s `lastRaw` dedupe only covers back-to-back scans of
  // the same INVALID/INCOMPATIBLE code (protects against a scanner firing
  // several frames of a bad read before the user moves the camera) — per
  // shareCollector.ts's own docs and
  // __tests__/recovery/shareCollector.test.ts's "after added, scanning the
  // same share again is duplicate via incompatible, not ignored", rescanning
  // an already-ACCEPTED share is a genuine 'incompatible'/'duplicate' event,
  // not a silent no-op. Both real behaviours are covered below.
  test('an identical invalid scan twice in a row is ignored: no repeated haptic', async () => {
    const screen = render(<ScanSharesScreen />)
    await act(async () => mockOnScan('not a share'))
    await waitFor(() => expect(screen.getByText('scan_shares_invalid_format')).toBeTruthy())

    await act(async () => mockOnScan('not a share'))
    expect(screen.getByText('scan_shares_invalid_format')).toBeTruthy()
    expect(mockHapticError).not.toHaveBeenCalled()
  })

  test('rescanning an already-accepted share reports scan_shares_duplicate, progress unchanged', async () => {
    const { mnemonic } = generateMnemonicWallet()
    const entropy = Mnemonic.fromString(mnemonic).toEntropy()
    const shares = generateEntropyShares(entropy)

    const screen = render(<ScanSharesScreen />)
    await act(async () => mockOnScan(shares[0]))
    await waitFor(() => expect(screen.getByText('scan_shares_progress {"scanned":1,"needed":2}')).toBeTruthy())
    expect(mockHapticSuccess).toHaveBeenCalledTimes(1)

    await act(async () => mockOnScan(shares[0]))
    expect(screen.getByText('scan_shares_duplicate')).toBeTruthy()
    expect(mockHapticError).toHaveBeenCalledTimes(1)
    expect(screen.getByText('scan_shares_progress {"scanned":1,"needed":2}')).toBeTruthy()
    expect(mockSetMnemonic).not.toHaveBeenCalled()
  })

  test('a share from a different set is an integrity mismatch', async () => {
    const walletA = generateMnemonicWallet()
    const entropyA = Mnemonic.fromString(walletA.mnemonic).toEntropy()
    const sharesA = generateEntropyShares(entropyA)

    const walletB = generateMnemonicWallet()
    const entropyB = Mnemonic.fromString(walletB.mnemonic).toEntropy()
    const sharesB = generateEntropyShares(entropyB)

    const screen = render(<ScanSharesScreen />)
    await act(async () => mockOnScan(sharesA[0]))
    await act(async () => mockOnScan(sharesB[1]))

    await waitFor(() => expect(screen.getByText('scan_shares_integrity_mismatch')).toBeTruthy())
    expect(mockHapticError).toHaveBeenCalledTimes(1)
    expect(screen.getByText('scan_shares_progress {"scanned":1,"needed":2}')).toBeTruthy()
    expect(mockSetMnemonic).not.toHaveBeenCalled()
  })

  test('an invalid string shows the invalid-format error', async () => {
    const screen = render(<ScanSharesScreen />)
    await act(async () => mockOnScan('not a share'))
    await waitFor(() => expect(screen.getByText('scan_shares_invalid_format')).toBeTruthy())
  })

  test('a refused store, cancelled at the biometric prompt, builds nothing and resets the scanner', async () => {
    mockSetMnemonic.mockResolvedValueOnce(false)
    mockShowAlert.mockResolvedValueOnce('cancel')
    const { mnemonic } = generateMnemonicWallet()
    const entropy = Mnemonic.fromString(mnemonic).toEntropy()
    const shares = generateEntropyShares(entropy)

    const screen = render(<ScanSharesScreen />)
    await scanAll(shares.slice(0, 2))

    await waitFor(() =>
      expect(mockShowAlert).toHaveBeenCalledWith(expect.objectContaining({ title: 'scan_shares_biometric_title' }))
    )
    expect(mockBuild).not.toHaveBeenCalled()
    expect(mockDeleteRecoveredKey).not.toHaveBeenCalled()
    expect(mockAttest).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('scan_shares_scan_first')).toBeTruthy())
  })

  test('a failed restore, retried at the prompt, shows the restore-failed error and resets after exactly one build', async () => {
    mockRestoreState = { phase: 'failed', error: 'boom' }
    mockShowAlert.mockResolvedValueOnce('retry')
    const { mnemonic } = generateMnemonicWallet()
    const entropy = Mnemonic.fromString(mnemonic).toEntropy()
    const shares = generateEntropyShares(entropy)

    const screen = render(<ScanSharesScreen />)
    await scanAll(shares.slice(0, 2))

    await waitFor(() =>
      expect(mockShowAlert).toHaveBeenCalledWith(expect.objectContaining({ title: 'restore_backup_failed_title' }))
    )
    await waitFor(() => expect(screen.getByText('restore_backup_failed_title')).toBeTruthy())
    expect(mockHapticError).toHaveBeenCalled()
    expect(mockBuild).toHaveBeenCalledTimes(1)
    expect(mockAttest).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('scan_shares_scan_first')).toBeTruthy())
  })

  test('a failed restore, skipped at the prompt, rebuilds without history and celebrates', async () => {
    mockRestoreState = { phase: 'failed', error: 'boom' }
    mockShowAlert.mockResolvedValueOnce('skip')
    const { mnemonic } = generateMnemonicWallet()
    const entropy = Mnemonic.fromString(mnemonic).toEntropy()
    const shares = generateEntropyShares(entropy)

    const screen = render(<ScanSharesScreen />)
    await scanAll(shares.slice(0, 2))

    await waitFor(() => expect(mockBuild).toHaveBeenCalledTimes(2))
    expect(mockBuild).toHaveBeenNthCalledWith(1, mnemonic, { restoreFromBackup: true })
    expect(mockBuild).toHaveBeenNthCalledWith(2, mnemonic, { restoreFromBackup: false })
    await waitFor(() => expect(mockAttest).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('celebration')).toBeTruthy())
  })

  test('a thrown build error shows the translated failure message, logs the detail, and resets the scanner', async () => {
    mockBuild.mockRejectedValueOnce(new Error('boom-build'))
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const { mnemonic } = generateMnemonicWallet()
    const entropy = Mnemonic.fromString(mnemonic).toEntropy()
    const shares = generateEntropyShares(entropy)

    const screen = render(<ScanSharesScreen />)
    await scanAll(shares.slice(0, 2))

    await waitFor(() => expect(screen.getByText('scan_shares_recovery_failed')).toBeTruthy())
    expect(screen.queryByText('boom-build')).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith('[ScanShares] Recovery failed:', 'boom-build')
    expect(mockHapticError).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('scan_shares_scan_first')).toBeTruthy())
    errorSpy.mockRestore()
  })

  test('an existing identity asks to confirm the replace; declining stores nothing (P1-7 layer 2)', async () => {
    mockHasStoredIdentity.mockResolvedValue(true)
    mockShowAlert.mockResolvedValueOnce('cancel')
    const { mnemonic } = generateMnemonicWallet()
    const entropy = Mnemonic.fromString(mnemonic).toEntropy()
    const shares = generateEntropyShares(entropy)

    const screen = render(<ScanSharesScreen />)
    await scanAll(shares.slice(0, 2))

    await waitFor(() =>
      expect(mockShowAlert).toHaveBeenCalledWith(expect.objectContaining({ title: 'recovery_replace_wallet_title' }))
    )
    expect(mockSetMnemonic).not.toHaveBeenCalled()
    expect(mockBuild).not.toHaveBeenCalled()
    expect(screen.queryByText('celebration')).toBeNull()
  })

  test('a thrown secretFromShares error shows the translated failure message and logs the detail', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockSecretFromShares.mockImplementationOnce(() => {
      throw new Error('bad shares detail')
    })
    const { mnemonic } = generateMnemonicWallet()
    const entropy = Mnemonic.fromString(mnemonic).toEntropy()
    const shares = generateEntropyShares(entropy)

    const screen = render(<ScanSharesScreen />)
    await scanAll(shares.slice(0, 2))

    await waitFor(() => expect(screen.getByText('scan_shares_recovery_failed')).toBeTruthy())
    expect(screen.queryByText('bad shares detail')).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith('[ScanShares] Recovery failed:', 'bad shares detail')
    errorSpy.mockRestore()
  })
})
