/**
 * XR-085 review follow-up: an imported-and-quarantined 'import_hold' row is
 * safe (findOfflineActions() drain queries never select it — see
 * refreshProofGuard.test.ts and importDatabases.test.ts), but WalletHomeScreen's
 * own findOfflineActions query (fetchOfflineRows) never asked for 'import_hold'
 * either, so the row's offlineStatus was always undefined here and
 * txStatusView fell through to the raw underlying status ("Not sent")
 * instead of the commit's intended "Held (imported)". This locks the wiring:
 * ActivityRow must receive offlineStatus: 'import_hold' for such a row.
 *
 * Mocks mirror walletHomeFilter.test.tsx (same screen, same barrel import).
 */
import React from 'react'
import { act, render } from '@testing-library/react-native'
import { WalletHomeScreen } from '../../ui/screens/WalletHomeScreen'

const mockRouter = { push: jest.fn(), replace: jest.fn() }
let mockWallet: any
let mockContactsStore: any

const HELD_TXID = 'a'.repeat(64)

const mockFindOfflineActions = jest.fn(async (_db: unknown, filter: { status?: string[] } = {}) => {
  const row = {
    offlineActionId: 1,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    userId: 1,
    txid: HELD_TXID,
    seq: 1,
    role: 'sent',
    senderIdentityKey: null,
    receivedVia: null,
    status: 'import_hold',
    rejectedReason: null,
    poisonedByTxid: null,
    framePayload: null
  }
  if (!filter.status || filter.status.includes('import_hold')) return [row]
  return []
})

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
    splitAmountFraction: jest.requireActual('../../core/amountFormatHelpers').splitAmountFraction,
    isFiatCurrency: jest.requireActual('../../core/amountFormatHelpers').isFiatCurrency,
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
    getOutboxEntries: async () => [],
    unsentEntries: () => [],
    listPendingResendRequests: async () => [],
    loadUnansweredResends: async () => [],
    findOfflineActions: (...args: unknown[]) => mockFindOfflineActions(...(args as [unknown, any])),
    TaskCreditInbox: { lastAttentionCount: 0 },
    TaskSendOffline: { lastStall: null },
    isBackupPushEnabled: async () => true,
    isVaultEnabled: () => false,
    isVaultAvailable: () => false,
    useVault: () => ({
      state: { phase: 'idle' },
      submitPin: jest.fn(),
      cancel: jest.fn(),
      retry: jest.fn(),
      hasVaultMeta: false
    }),
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
jest.mock('@bsv/wallet-toolbox-mobile', () => ({
  sdk: { specOpWalletBalance: 'specOpWalletBalance' },
  WalletMonitorTask: class WalletMonitorTask {}
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${Object.values(values).join('|')}` : key)
  })
}))
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
jest.mock('../../ui/components/wallet/BackupReminderSheet', () => ({ BackupReminderSheet: () => null }))
jest.mock('../../ui/components/wallet/BiometricAdvisoryModal', () => ({ BiometricAdvisoryModal: () => null }))
jest.mock('../../ui/components/wallet/ImportFromBackupPrompt', () => ({ ImportFromBackupPrompt: () => null }))
jest.mock('../../ui/components/wallet/ActivityRow', () => {
  const React = require('react')
  const { Text } = require('react-native')
  return ({ action, offlineStatus }: any) =>
    React.createElement(Text, {}, `row:${action.txid}:${String(offlineStatus)}`)
})
jest.mock('../../ui/components/security/WalletLockNotice', () => () => null)
jest.mock('../../ui/components/pay/OfflineNotice', () => () => null)
jest.mock('../../ui/hooks/useOnline', () => ({ useOnline: () => false }))
jest.mock('../../ui/hooks/useContactsStore', () => ({ useContactsStore: () => mockContactsStore }))
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
    ListRow: ({ label, subtitle, trailing, onPress }: any) =>
      React.createElement(
        Pressable,
        { onPress },
        React.createElement(Text, {}, label),
        subtitle ? React.createElement(Text, {}, subtitle) : null,
        trailing ?? null
      )
  }
})
jest.mock('../../ui/components/ui/GroupedList', () => {
  const React = require('react')
  const { Text, View } = require('react-native')
  return {
    GroupedSection: ({ header, footer, children }: any) =>
      React.createElement(
        View,
        {},
        header ? React.createElement(Text, {}, header) : null,
        children,
        footer ? React.createElement(Text, {}, footer) : null
      )
  }
})

const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setImmediate(resolve))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockContactsStore = { listContacts: jest.fn(async () => []) }
  mockWallet = {
    managers: {
      permissionsManager: {
        getPublicKey: jest.fn(async () => ({ publicKey: '02' + 'a'.repeat(64) })),
        listOutputs: jest.fn(async () => ({ totalOutputs: 0 })),
        listActions: jest.fn(async ({ offset }: { offset: number }) => ({
          totalActions: 1,
          actions:
            offset === 0
              ? [
                  {
                    txid: HELD_TXID,
                    satoshis: -500,
                    labels: ['peerpay'],
                    description: 'Old imported payment',
                    created_at: '2026-08-01T10:00:00Z',
                    status: 'nosend'
                  }
                ]
              : []
        }))
      }
    },
    adminOriginator: 'admin.test',
    selectedNetwork: 'main',
    settings: {},
    // sqliteDb truthy: fetchOfflineRows only calls findOfflineActions once
    // storage answers with a database handle.
    storage: { chain: 'main', sqliteDb: {} },
    txStatusVersion: 0,
    walletUserId: 1,
    walletBuilt: true,
    walletBuilding: false,
    buildWalletFromMnemonic: jest.fn(),
    mandala: undefined
  }
})

describe("XR-085: WalletHomeScreen surfaces an import_hold row's offline status", () => {
  test("the held row's ActivityRow receives offlineStatus: 'import_hold', not undefined", async () => {
    const screen = render(<WalletHomeScreen />)
    await settle()
    await settle()

    expect(mockFindOfflineActions).toHaveBeenCalled()
    expect(screen.getByText(`row:${HELD_TXID}:import_hold`)).toBeTruthy()
    expect(screen.queryByText(`row:${HELD_TXID}:undefined`)).toBeNull()
  })
})
