/**
 * The vault's release gate (spec §5.5, D15): with `vaultEnabled` off the home
 * screen has no Vault destination and Settings has no Vault row, so no path
 * can enrol hardware or create a vault output; with it on, both appear and
 * push /vault directly (enrolment needs no wallet).
 *
 * The barrel mock mirrors walletHomeBackup.test.tsx — WalletHomeScreen pulls
 * in the whole wallet surface — plus `isVaultEnabled`.
 */
import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'
import { WalletHomeScreen } from '../../ui/screens/WalletHomeScreen'
import { SettingsScreen } from '../../ui/screens/SettingsScreen'

const IDENTITY = '02' + 'a'.repeat(64)
const mockRouter = { push: jest.fn(), replace: jest.fn() }
let mockVaultEnabled = false
let mockWallet: any

jest.mock('@bsv/expo-wallet-toolbox', () => {
  const React = require('react')
  return {
    ...jest.requireActual('../../core/theme/tokens'),
    useTheme: () => ({ colors: {} }),
    useWallet: () => mockWallet,
    useLocalStorage: () => ({
      hasStoredIdentity: async () => true,
      createMnemonic: jest.fn(),
      getMnemonic: async () => 'synthetic stored phrase',
      getRecoveredKey: async () => null,
      secretsReady: true
    }),
    generateMnemonicWallet: jest.fn(),
    backupAttestation: jest.requireActual('../../core/services/vault/backupAttestation').backupAttestation,
    ExchangeRateContext: React.createContext({ satoshisPerUSD: 1000, usdToFiat: {} }),
    UserContext: React.createContext({ appName: 'Test Wallet' }),
    formatAmountParts: () => ({ integer: '0', fraction: '', unit: 'BSV' }),
    formatAmount: () => '0',
    formatSatoshisAsBsvDecimal: () => '0',
    TaskCreditInbox: { lastAttentionCount: 0 },
    TaskSendOffline: { lastStall: null },
    isBackupPushEnabled: async () => true,
    isVaultEnabled: () => mockVaultEnabled,
    arcUrlStorageKey: () => 'arc_url',
    arcApiTokenStorageKey: () => 'arc_token',
    DEFAULT_ARC_URLS: { main: '' },
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
  useLocalSearchParams: () => ({}),
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect])
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('@bsv/message-box-client', () => ({ PeerPayClient: jest.fn() }))
jest.mock('@bsv/wallet-toolbox-mobile', () => ({ sdk: { specOpWalletBalance: 'specOpWalletBalance' } }))
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
jest.mock('../../ui/components/ui/ScreenGradient', () => ({ __esModule: true, default: ({ children }: any) => children }))
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
  return { ListRow: ({ label, onPress }: any) => React.createElement(Pressable, { onPress }, React.createElement(Text, {}, label)) }
})
jest.mock('../../ui/components/ui/GroupedList', () => ({ GroupedSection: ({ children }: any) => children }))

beforeEach(() => {
  jest.clearAllMocks()
  mockVaultEnabled = false
  mockWallet = {
    managers: {
      permissionsManager: {
        getPublicKey: jest.fn(async () => ({ publicKey: IDENTITY })),
        listOutputs: jest.fn(async () => ({ totalOutputs: 0 }))
      }
    },
    adminOriginator: 'admin.test',
    selectedNetwork: 'main',
    settings: {},
    storage: null,
    txStatusVersion: 0,
    walletUserId: null,
    walletBuilt: true,
    walletBuilding: false,
    buildWalletFromMnemonic: jest.fn()
  }
})

describe('WalletHomeScreen', () => {
  test('has no Vault destination while the flag is off', async () => {
    const screen = render(<WalletHomeScreen />)
    await act(async () => {})
    expect(screen.getByText('pay_direction_pay')).toBeTruthy()
    expect(screen.queryByText('wallet_vault')).toBeNull()
  })

  test('shows the Vault destination when the flag is on and pushes /vault directly', async () => {
    mockVaultEnabled = true
    const screen = render(<WalletHomeScreen />)
    await act(async () => {})
    await act(async () => fireEvent.press(screen.getByText('wallet_vault')))
    expect(mockRouter.push).toHaveBeenCalledWith('/vault')
  })
})

describe('SettingsScreen', () => {
  test('has no Vault row while the flag is off', async () => {
    const screen = render(<SettingsScreen />)
    await act(async () => {})
    expect(screen.getByText('payments')).toBeTruthy()
    expect(screen.queryByText('vault_row_title')).toBeNull()
  })

  test('shows the Vault row when the flag is on', async () => {
    mockVaultEnabled = true
    const screen = render(<SettingsScreen />)
    await act(async () => {})
    await act(async () => fireEvent.press(screen.getByText('vault_row_title')))
    expect(mockRouter.push).toHaveBeenCalledWith('/vault')
  })
})
