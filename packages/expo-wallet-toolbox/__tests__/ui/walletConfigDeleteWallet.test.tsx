/**
 * XR-107 (UI half): WalletConfigScreen's "Log Out" row is wired straight to
 * WalletContext's logout(), which IS "Delete Wallet" (its own confirm dialog
 * says so). The screen used to fire logout() and forget it — never checking
 * whether the secrets layer actually verified the legacy plaintext namespace
 * erased, so a persistent SecureStore delete failure was reported to the
 * user as a normal, successful deletion.
 *
 * This exercises the real screen (same heavy-mock harness as
 * __tests__/ui/walletConfigArc.test.tsx) with a controllable `logout()`,
 * proving the screen now surfaces a failure and lets the user retry instead
 * of silently behaving as though the wallet were gone.
 */
import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { WalletConfigScreen } from '../../ui/screens/WalletConfigScreen'
import { showAlert } from '../../ui/components/ui/AlertCard'

const mockRouter = { push: jest.fn(), replace: jest.fn() }
let mockWallet: any

jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('../../ui/components/ui/SlideOverFromRight', () => ({ __esModule: true, default: () => null }))
jest.mock('expo-local-authentication', () => ({
  getEnrolledLevelAsync: jest.fn(async () => 0),
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: false }))
}))
jest.mock('@bsv/expo-wallet-toolbox', () => {
  const React = require('react')
  return {
    ...jest.requireActual('../../core/theme/tokens'),
    ...jest.requireActual('../../core/theme/motion'),
    ...jest.requireActual('../../core/numberFormat'),
    splitAmountFraction: jest.requireActual('../../core/amountFormatHelpers').splitAmountFraction,
    isFiatCurrency: jest.requireActual('../../core/amountFormatHelpers').isFiatCurrency,
    validateArcUrl: jest.requireActual('../../core/net/validateArcUrl').validateArcUrl,
    useTheme: () => ({ colors: {} }),
    useWallet: () => mockWallet,
    useLocalStorage: () => ({
      hasStoredIdentity: jest.fn(async () => true),
      createMnemonic: jest.fn(),
      getMnemonic: jest.fn(),
      getRecoveredKey: jest.fn(async () => null),
      secretsReady: true
    }),
    backupAttestation: jest.requireActual('../../core/services/vault/backupAttestation').backupAttestation,
    ExchangeRateContext: React.createContext({ satoshisPerUSD: 1000 }),
    UserContext: React.createContext({ appName: 'Test Wallet' }),
    formatAmountParts: () => ({ integer: '0', fraction: '', unit: 'BSV' }),
    formatAmount: () => '0',
    formatSatoshisAsBsvDecimal: () => '0',
    TaskCreditInbox: { lastAttentionCount: 0 },
    TaskSendOffline: { lastStall: null },
    isBackupPushEnabled: async () => true,
    isVaultEnabled: () => true,
    isVaultAvailable: (chain: string) => chain === 'main',
    useVault: () => ({
      state: { phase: 'idle' },
      submitPin: jest.fn(),
      cancel: jest.fn(),
      retry: jest.fn(),
      hasVaultMeta: false
    }),
    arcUrlStorageKey: () => 'arc_url',
    arcApiTokenStorageKey: () => 'arc_token',
    getArcApiToken: jest.requireActual('../../core/services/arcTokenStorage').getArcApiToken,
    setArcApiToken: jest.requireActual('../../core/services/arcTokenStorage').setArcApiToken,
    DEFAULT_ARC_URLS: { main: 'https://arc.gorillapool.io' },
    KNOWN_ARC_URLS: [],
    DISPLAY_CURRENCY_OPTIONS: [],
    DEFAULT_AUTO_APPROVE_THRESHOLD: 0,
    AUTO_APPROVE_STORAGE_KEY: 'auto_approve',
    ADVANCED_SETTINGS_EXPANDED_KEY: 'advanced',
    getBackupUrl: () => ''
  }
})
jest.mock('expo-router', () => ({
  router: mockRouter,
  useLocalSearchParams: () => ({ section: undefined }),
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect])
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('@bsv/message-box-client', () => ({ PeerPayClient: jest.fn() }))
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
jest.mock('../../ui/components/wallet/BackupReminderSheet', () => ({ BackupReminderSheet: () => null }))
jest.mock('../../ui/components/wallet/BiometricAdvisoryModal', () => ({ BiometricAdvisoryModal: () => null }))
jest.mock('../../ui/components/wallet/ImportFromBackupPrompt', () => ({ ImportFromBackupPrompt: () => null }))
jest.mock('../../ui/components/wallet/ActivityRow', () => () => null)
jest.mock('../../ui/components/security/WalletLockNotice', () => () => null)
jest.mock('../../ui/components/pay/OfflineNotice', () => () => null)
jest.mock('../../ui/hooks/useOnline', () => ({ useOnline: () => false }))
jest.mock('../../ui/hooks/useOfflineNoticeActions', () => ({ useOfflineNoticeActions: () => ({}) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))
jest.mock('../../ui/exportTransactions', () => ({ exportTransactionsAsCsv: jest.fn() }))
jest.mock('../../ui/components/ui/ScreenGradient', () => ({
  __esModule: true,
  default: ({ children }: any) => children
}))
jest.mock('../../ui/components/ui/ScrollFade', () => ({
  __esModule: true,
  default: () => null,
  sampleScreenGradient: () => '#000000'
}))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return ({ children, onPress, ...props }: any) => React.createElement(Pressable, { onPress, ...props }, children)
})
jest.mock('../../ui/components/ui/ListRow', () => {
  const React = require('react')
  const { Pressable, Text } = require('react-native')
  return {
    ListRow: ({ label, onPress }: any) =>
      React.createElement(Pressable, { onPress }, React.createElement(Text, {}, label))
  }
})
jest.mock('../../ui/components/ui/GroupedList', () => ({ GroupedSection: ({ children }: any) => children }))
jest.mock('../../ui/components/pay/MessageBoxConfig', () => ({
  ConfigPanel: () => null,
  useMessageBoxConfig: () => ({ messageBoxUrl: 'https://test.invalid' })
}))
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: jest.fn() }))
jest.mock('../../ui/exportDatabases', () => ({ exportAllWalletDatabases: jest.fn() }))
jest.mock('../../ui/importDatabases', () => ({ importWalletDatabase: jest.fn() }))
jest.mock('@react-native-clipboard/clipboard', () => ({ __esModule: true, default: { setString: jest.fn() } }))

const mockShowAlert = showAlert as jest.Mock
const mockLogout = jest.fn<Promise<boolean>, []>()

beforeEach(async () => {
  jest.clearAllMocks()
  await AsyncStorage.clear()
  mockWallet = {
    managers: { permissionsManager: { getPublicKey: jest.fn(async () => ({ publicKey: '02' + 'a'.repeat(64) })) } },
    adminOriginator: 'admin.test',
    selectedNetwork: 'main',
    settings: {},
    storage: null,
    logout: mockLogout,
    switchNetwork: jest.fn(),
    updateSettings: jest.fn(async () => {}),
    rebuildWallet: jest.fn(async () => {})
  }
})

async function renderConfig() {
  const screen = render(<WalletConfigScreen />)
  await act(async () => {})
  return screen
}

/** Confirms the destructive alert, then presses the confirm button. */
async function pressLogOutAndConfirm(screen: ReturnType<typeof render>) {
  mockShowAlert.mockResolvedValueOnce('delete')
  await act(async () => fireEvent.press(screen.getByText('log_out')))
}

describe('XR-107: Delete Wallet surfaces an unverified erasure instead of reporting success', () => {
  it('shows a failure alert and re-enables the row for retry when logout() cannot verify erasure', async () => {
    mockLogout.mockResolvedValue(false)
    const screen = await renderConfig()

    await pressLogOutAndConfirm(screen)

    expect(mockLogout).toHaveBeenCalledTimes(1)
    // The second showAlert call is the failure report — the first was the
    // "are you sure" confirmation the test itself answered.
    expect(mockShowAlert).toHaveBeenCalledTimes(2)
    expect(mockShowAlert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        title: 'delete_wallet_failed_title',
        message: 'delete_wallet_failed_body'
      })
    )
    // Never navigated away as though the wallet were gone.
    expect(mockRouter.replace).not.toHaveBeenCalled()

    // The row must be usable again — pressing it a second time (the "retry")
    // must be able to call logout() again rather than being stuck.
    mockLogout.mockResolvedValue(true)
    await pressLogOutAndConfirm(screen)
    expect(mockLogout).toHaveBeenCalledTimes(2)
  })

  it('reports no failure alert when logout() verifies erasure', async () => {
    mockLogout.mockResolvedValue(true)
    const screen = await renderConfig()

    await pressLogOutAndConfirm(screen)

    expect(mockLogout).toHaveBeenCalledTimes(1)
    // Only the confirmation alert fired — no failure report.
    expect(mockShowAlert).toHaveBeenCalledTimes(1)
  })
})
