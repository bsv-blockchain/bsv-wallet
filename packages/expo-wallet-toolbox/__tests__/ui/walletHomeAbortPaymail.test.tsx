/**
 * Activity abort of a paymail action. The outbox row (or the network, when the
 * row is missing) decides; abortAction is never called for a payment the
 * receiver may hold. Mocks mirror walletHomeImportHold.test.tsx.
 */
import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'
import { WalletHomeScreen } from '../../ui/screens/WalletHomeScreen'

const mockRouter = { push: jest.fn(), replace: jest.fn() }
let mockWallet: any
let mockContactsStore: any

const HELD_TXID = 'a'.repeat(64)
let mockEntries: any[] = []
let mockStatusResults: any[] = []

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
    getOutboxEntries: async () => mockEntries,
    unsentEntries: (e: any[]) => e.filter(x => x.status === 'unsent'),
    isAbortSafe: jest.requireActual('../../core/pay/rails/handle').isAbortSafe,
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
    KNOWN_ARC_URLS: { main: [] },
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
  const { Pressable } = require('react-native')
  return ({ action, onAbort, onSendAgain }: any) =>
    React.createElement(
      React.Fragment,
      {},
      React.createElement(
        Pressable,
        { testID: `abort:${action.txid}`, onPress: () => onAbort(action.reference, action) },
        React.createElement(Text, {}, `row:${action.txid}`)
      ),
      React.createElement(Pressable, { testID: `again:${action.txid}`, onPress: () => onSendAgain?.(action) })
    )
})
jest.mock('../../ui/components/security/WalletLockNotice', () => () => null)
jest.mock('../../ui/components/pay/OfflineNotice', () => () => null)
jest.mock('../../ui/hooks/useOnline', () => ({ useOnline: () => false }))
jest.mock('../../ui/hooks/useContactsStore', () => ({ useContactsStore: () => mockContactsStore }))
jest.mock('../../ui/hooks/useOfflineNoticeActions', () => ({ useOfflineNoticeActions: () => ({}) }))
const mockCancelPaymail = jest.fn()
jest.mock('../../core/pay/rails/paymail', () => ({
  ...jest.requireActual('../../core/pay/rails/paymail'),
  cancelPaymailPayment: (...a: unknown[]) => mockCancelPaymail(...a),
  retryPaymailDelivery: (...a: unknown[]) => mockRetryPaymail(...a)
}))
const mockRetryPaymail = jest.fn()
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))
import { showToast } from '../../ui/components/ui/Toast'
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

const entry = (over: Record<string, unknown>) => ({
  kind: 'paymail',
  id: 'pm1',
  createdAt: '2026-09-01T00:00:00Z',
  status: 'unsent',
  txid: HELD_TXID,
  paymail: 'a@b.io',
  endpoint: 'https://b.io/beef',
  paymailReference: 'r',
  beefHex: '00',
  satoshis: 500,
  ...over
})

let pm: any

beforeEach(() => {
  jest.clearAllMocks()
  mockEntries = []
  mockStatusResults = [{ txid: HELD_TXID, status: 'known' }]
  mockContactsStore = { listContacts: jest.fn(async () => []) }
  pm = {
    getPublicKey: jest.fn(async () => ({ publicKey: '02' + 'a'.repeat(64) })),
    listOutputs: jest.fn(async () => ({ totalOutputs: 0 })),
    abortAction: jest.fn(async () => ({ aborted: true })),
    createAction: jest.fn(async (a: any) => ({
      sendWithResults: [{ txid: a.options.sendWith[0], status: 'sending' }]
    })),
    listActions: jest.fn(async (args: { offset?: number; labels?: string[]; limit?: number }) => ({
      totalActions: 1,
      actions:
        args.offset === 0 || args.offset === undefined
          ? [
              {
                txid: HELD_TXID,
                reference: 'ref-1',
                satoshis: -500,
                labels: ['paymail', 'paymail:a@b.io'],
                description: 'Paymail payment',
                created_at: '2026-08-01T10:00:00Z',
                status: 'nosend'
              }
            ]
          : []
    }))
  }
  mockWallet = {
    managers: { permissionsManager: pm },
    adminOriginator: 'admin.test',
    selectedNetwork: 'main',
    settings: {},
    storage: {
      chain: 'main',
      sqliteDb: {},
      getServices: () => ({
        getStatusForTxids: async () => ({ status: 'success', results: mockStatusResults })
      })
    },
    txStatusVersion: 0,
    walletUserId: 1,
    walletBuilt: true,
    walletBuilding: false,
    buildWalletFromMnemonic: jest.fn(),
    mandala: undefined
  }
})

async function abort() {
  const screen = render(<WalletHomeScreen />)
  await settle()
  await settle()
  await act(async () => {
    fireEvent.press(screen.getByTestId(`abort:${HELD_TXID}`))
  })
  await settle()
}

describe('WalletHomeScreen: Activity abort of a paymail action', () => {
  for (const flags of [{ delivering: true }, { delivered: true }]) {
    test(`a row that is ${Object.keys(flags)[0]} is not aborted and shows the maybe-delivered toast`, async () => {
      mockEntries = [entry(flags)]
      await abort()
      expect(pm.abortAction).not.toHaveBeenCalled()
      expect(showToast).toHaveBeenCalledWith('tx_abort_maybe_delivered', { type: 'error' })
    })
  }

  test('a missing row resolves through the network and never calls abortAction when the network knows the txid', async () => {
    mockEntries = []
    await abort()
    expect(pm.abortAction).not.toHaveBeenCalled()
    expect(pm.createAction).toHaveBeenCalledWith(
      expect.objectContaining({ options: { sendWith: [HELD_TXID] } }),
      'admin.test'
    )
  })

  test('a missing row the network does not know is aborted through the orphan path', async () => {
    mockEntries = []
    mockStatusResults = []
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    const screen = render(<WalletHomeScreen />)
    await settle()
    await settle()
    await act(async () => {
      fireEvent.press(screen.getByTestId(`abort:${HELD_TXID}`))
      await jest.advanceTimersByTimeAsync(5000)
    })
    await settle()
    jest.useRealTimers()
    expect(pm.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.test')
  })

  test('an unsent row is cancelled through the network-decides rule, never a bare abortAction', async () => {
    mockEntries = [entry({})]
    mockCancelPaymail.mockResolvedValue({ aborted: true, sent: false })
    await abort()
    expect(mockCancelPaymail).toHaveBeenCalledWith(expect.objectContaining({ entry: mockEntries[0] }))
    expect(pm.abortAction).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('tx_abort_success', { type: 'success' })
  })

  test('an unsent row the network knows is not reported as cancelled', async () => {
    mockEntries = [entry({ lastAttemptAt: '2026-09-01T00:00:00Z' })]
    mockCancelPaymail.mockResolvedValue({ aborted: false, sent: true })
    await abort()
    expect(pm.abortAction).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('tx_abort_maybe_delivered', { type: 'error' })
  })

  test('a failed cancel shows its message and aborts nothing directly', async () => {
    mockEntries = [entry({})]
    mockCancelPaymail.mockRejectedValue(new Error('Could not check the network.'))
    await abort()
    expect(pm.abortAction).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('Could not check the network.', { type: 'error' })
  })

  test('send again on a refused row does not retry and does not report success', async () => {
    mockEntries = [entry({ refused: true })]
    const screen = render(<WalletHomeScreen />)
    await settle()
    await settle()
    await act(async () => {
      fireEvent.press(screen.getByTestId(`again:${HELD_TXID}`))
    })
    await settle()
    expect(mockRetryPaymail).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Cancel'), { type: 'error' })
  })
})
