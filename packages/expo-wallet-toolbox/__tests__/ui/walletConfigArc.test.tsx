/**
 * XR-064: Custom ARC endpoints allow cleartext transaction delivery and a
 * token that silently follows to a different, later-configured origin.
 */
import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { WalletConfigScreen } from '../../ui/screens/WalletConfigScreen'

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

const mockRebuildWallet = jest.fn(async () => {})

beforeEach(async () => {
  jest.clearAllMocks()
  await AsyncStorage.clear()
  mockWallet = {
    managers: { permissionsManager: { getPublicKey: jest.fn(async () => ({ publicKey: '02' + 'a'.repeat(64) })) } },
    adminOriginator: 'admin.test',
    selectedNetwork: 'main',
    settings: {},
    storage: null,
    logout: jest.fn(),
    switchNetwork: jest.fn(),
    updateSettings: jest.fn(async () => {}),
    rebuildWallet: mockRebuildWallet
  }
})

async function renderConfig() {
  const screen = render(<WalletConfigScreen />)
  await act(async () => {})
  return screen
}

async function openArcSection(screen: ReturnType<typeof render>) {
  await act(async () => fireEvent.press(screen.getByText('advanced')))
  await act(async () => fireEvent.press(screen.getByText('arc_endpoint')))
}

describe('XR-064: custom ARC endpoint validation and token scoping', () => {
  it('rejects a plaintext http endpoint: no AsyncStorage write, error shown', async () => {
    const screen = await renderConfig()
    await openArcSection(screen)

    const urlInput = screen.getByPlaceholderText('https://...')
    fireEvent.changeText(urlInput, 'http://evil.example.com')
    await act(async () => fireEvent.press(screen.getByText('arc_apply')))

    expect(await AsyncStorage.getItem('arc_url')).toBeNull()
    expect(screen.getByText('arc_url_https_required')).toBeTruthy()
    expect(mockRebuildWallet).not.toHaveBeenCalled()
  })

  it('accepts a valid https endpoint and stores the token for it', async () => {
    const screen = await renderConfig()
    await openArcSection(screen)

    fireEvent.changeText(screen.getByPlaceholderText('https://...'), 'https://custom.example.com')
    fireEvent.changeText(screen.getByPlaceholderText('Optional'), 'secret-token-A')
    await act(async () => fireEvent.press(screen.getByText('arc_apply')))

    expect(await AsyncStorage.getItem('arc_url')).toBe('https://custom.example.com')
    expect(await AsyncStorage.getItem('arc_token')).toBe('secret-token-A')
    expect(mockRebuildWallet).toHaveBeenCalledTimes(1)
  })

  // XR-064: the API token is saved/cleared independently of the URL, so
  // changing only the endpoint used to leave a previously entered token
  // attached to the new host.
  it('does NOT carry a previously-saved token over to a newly-applied, different origin', async () => {
    await AsyncStorage.setItem('arc_url', 'https://custom.example.com')
    await AsyncStorage.setItem('arc_token', 'secret-token-A')

    const screen = await renderConfig()
    await openArcSection(screen)

    // The screen loads the persisted URL and token into the fields.
    expect(screen.getByDisplayValue('https://custom.example.com')).toBeTruthy()
    expect(screen.getByDisplayValue('secret-token-A')).toBeTruthy()

    // The person changes ONLY the URL to a different https origin, leaving
    // the token field exactly as loaded.
    fireEvent.changeText(screen.getByPlaceholderText('https://...'), 'https://other.example.com')
    await act(async () => fireEvent.press(screen.getByText('arc_apply')))

    expect(await AsyncStorage.getItem('arc_url')).toBe('https://other.example.com')
    // The old token must not have followed to the new origin.
    expect(await AsyncStorage.getItem('arc_token')).toBeNull()
  })

  it('keeps the token when re-applying the same origin unchanged', async () => {
    await AsyncStorage.setItem('arc_url', 'https://custom.example.com')
    await AsyncStorage.setItem('arc_token', 'secret-token-A')

    const screen = await renderConfig()
    await openArcSection(screen)
    await act(async () => fireEvent.press(screen.getByText('arc_apply')))

    expect(await AsyncStorage.getItem('arc_url')).toBe('https://custom.example.com')
    expect(await AsyncStorage.getItem('arc_token')).toBe('secret-token-A')
  })

  it('honors a genuinely new token typed alongside a new origin in the same action', async () => {
    await AsyncStorage.setItem('arc_url', 'https://custom.example.com')
    await AsyncStorage.setItem('arc_token', 'secret-token-A')

    const screen = await renderConfig()
    await openArcSection(screen)

    fireEvent.changeText(screen.getByPlaceholderText('https://...'), 'https://other.example.com')
    // The person deliberately types a DIFFERENT token for the new host.
    fireEvent.changeText(screen.getByDisplayValue('secret-token-A'), 'secret-token-B')
    await act(async () => fireEvent.press(screen.getByText('arc_apply')))

    expect(await AsyncStorage.getItem('arc_url')).toBe('https://other.example.com')
    expect(await AsyncStorage.getItem('arc_token')).toBe('secret-token-B')
  })

  it('allows the explicit http://localhost loopback dev exception', async () => {
    const screen = await renderConfig()
    await openArcSection(screen)

    fireEvent.changeText(screen.getByPlaceholderText('https://...'), 'http://localhost:9090')
    await act(async () => fireEvent.press(screen.getByText('arc_apply')))

    expect(await AsyncStorage.getItem('arc_url')).toBe('http://localhost:9090')
  })
})
