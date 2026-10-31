/**
 * Troubleshooting checklist. Ports are injected so the screen runs the real
 * runWalletCheck state machine without MessageBox, ARC or WhatsOnChain.
 * Copy is the i18n key: this file does not initialise i18next.
 */
import React from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react-native'
import type { WalletCheckPorts } from '../../core/walletRepair/runWalletCheck'

jest.mock('react-i18next', () => {
  // Stable `t`. A new function each render retriggers the screen's run effect.
  const t = (key: string) => key
  return { useTranslation: () => ({ t }) }
})

// The screen's repair hooks import the pay rails and MessageBox client at
// module scope. The checklist under test receives its ports as props, so those
// modules are never called here. Mocking them keeps the worker off the graph
// that otherwise exhausts the heap while the file is loading.
jest.mock('@bsv/message-box-client', () => ({ PeerPayClient: class PeerPayClient {} }))
jest.mock('../../core/pay/creditErrors', () => ({ makeCreditClassifier: jest.fn() }))
jest.mock('../../core/pay/creditInbox', () => ({ creditInboxOnce: jest.fn() }))
jest.mock('../../core/pay/beefRepair', () => ({ makeBeefRepair: jest.fn() }))
jest.mock('../../core/pay/receiveHistory', () => ({ getIssuedDates: jest.fn() }))
jest.mock('../../core/directpay/receive', () => ({ inboxSeenStore: jest.fn() }))
jest.mock('../../core/pay/rails/handle', () => ({
  acceptWithRetry: jest.fn(),
  bindMessageBoxNetwork: jest.fn(),
  internalizeIncoming: jest.fn(),
  readMessageBoxUrl: jest.fn()
}))
jest.mock('../../core/pay/rails/address', () => ({
  derivationPrefixFor: jest.fn(),
  getPaymentAddress: jest.fn(),
  recoveryDatesToScan: jest.fn(),
  sweepAddress: jest.fn(),
  wocConfigFor: jest.fn()
}))
jest.mock('../../core/services/vault/backupAttestation', () => ({ backupAttestation: { get: jest.fn() } }))
jest.mock('../../core/backup/status', () => ({ getBackupUploadState: jest.fn() }))

jest.mock('@bsv/expo-wallet-toolbox', () => {
  const tokens = jest.requireActual('../../core/theme/tokens')
  const wallet = {
    managers: null,
    adminOriginator: 'admin.test',
    storage: null,
    selectedNetwork: 'test',
    getBackupPseudonym: () => null,
    checkUtxoSpendability: jest.fn(),
    releaseStuckReservations: jest.fn(),
    runMonitorTask: jest.fn(),
    peekLastMissHeight: jest.fn(),
    mandala: null
  }
  const theme = { colors: tokens.darkColors }
  return {
    ...tokens,
    useTheme: () => theme,
    useWallet: () => wallet,
    getOnline: jest.fn(async () => true),
    haptics: { success: jest.fn(), error: jest.fn(), light: jest.fn() }
  }
})

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
  useFocusEffect: (effect: () => void) => {
    require('react').useEffect(effect, [effect])
  }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

import { WalletCheckScreen } from '../../ui/screens/WalletCheckScreen'

function healthy(over: Partial<WalletCheckPorts> = {}): WalletCheckPorts {
  return {
    checkOnline: async () => ({ online: true }),
    checkBackup: async () => ({ enabled: true, uploaded: true }),
    checkPhraseBackup: async () => ({ backedUp: true }),
    reviewSpendable: async () => ({ released: 0, recovered: 0 }),
    reviewTokens: async () => ({ settled: 0, removed: 0, unattested: 0 }),
    checkProofs: async () => ({ repaired: 0 }),
    reviewStatus: async () => ({ failedTxs: 0, restoredInputs: 0 }),
    releaseStuck: async () => ({ released: 0 }),
    creditInbox: async () => ({ accepted: 0 }),
    sweepAddresses: async () => ({ imported: 0 }),
    ...over
  }
}

describe('WalletCheckScreen', () => {
  test('a healthy wallet lists every step and settles on the all-clear copy', async () => {
    const screen = render(<WalletCheckScreen ports={healthy()} />)

    expect(screen.getByText('check_wallet')).toBeTruthy()
    expect(screen.getByText('wallet_check_step_online')).toBeTruthy()
    expect(screen.getByText('wallet_check_step_coins')).toBeTruthy()

    await waitFor(() => expect(screen.getByText('wallet_check_ok')).toBeTruthy())
  })

  test('offline is attention, not the all-clear line', async () => {
    const screen = render(<WalletCheckScreen ports={healthy({ checkOnline: async () => ({ online: false }) })} />)

    await waitFor(() => expect(screen.getByText('wallet_check_attention')).toBeTruthy())
    expect(screen.queryByText('wallet_check_ok')).toBeNull()
  })

  test('skip abandons the step that is holding the list', async () => {
    let releaseOnline: (value: { online: boolean }) => void = () => {}
    const ports = healthy({
      checkOnline: () =>
        new Promise(resolve => {
          releaseOnline = resolve
        })
    })
    const screen = render(<WalletCheckScreen ports={ports} />)

    const skip = await screen.findByText('wallet_check_skip')
    fireEvent.press(skip)

    await waitFor(() => expect(screen.getByText('wallet_check_ok')).toBeTruthy())
    expect(screen.getByText('wallet_check_skipped')).toBeTruthy()
    // The hung check must not be required to finish.
    releaseOnline({ online: true })
  })
})
