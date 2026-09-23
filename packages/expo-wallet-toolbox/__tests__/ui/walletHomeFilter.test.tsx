/**
 * Home's activity filter: a filter button beside Export opens a search field
 * and a row of type chips above the list, and the list narrows as you type.
 *
 * The mocks mirror walletHomeTokens.test.tsx (WalletHomeScreen pulls in the
 * whole wallet surface); rows draw as `row:<txid>` so a test can read which
 * transactions survived.
 */
import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'
import { WalletHomeScreen } from '../../ui/screens/WalletHomeScreen'

const IDENTITY = '02' + 'a'.repeat(64)
const mockRouter = { push: jest.fn(), replace: jest.fn() }
let mockWallet: any
let mockContactsStore: any

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
    // The activity tests mount a storage on this chain so the list actually
    // loads; these are what the screen touches on a mounted storage.
    getOutboxEntries: async () => [],
    unsentEntries: () => [],
    listPendingResendRequests: async () => [],
    loadUnansweredResends: async () => [],
    TaskCreditInbox: { lastAttentionCount: 0 },
    TaskSendOffline: { lastStall: null },
    isBackupPushEnabled: async () => true,
    isVaultEnabled: () => false,
    isVaultAvailable: () => false,
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
  // Base class of the app's monitor tasks, which import it from the package root.
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
  return ({ action }: any) => React.createElement(Text, {}, `row:${action.txid}`)
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
        getPublicKey: jest.fn(async () => ({ publicKey: IDENTITY })),
        listOutputs: jest.fn(async () => ({ totalOutputs: 0 })),
        listActions: jest.fn(async () => ({ totalActions: 0, actions: [] }))
      }
    },
    adminOriginator: 'admin.test',
    selectedNetwork: 'main',
    settings: {},
    storage: { chain: 'main' },
    txStatusVersion: 0,
    walletUserId: 1,
    walletBuilt: true,
    walletBuilding: false,
    buildWalletFromMnemonic: jest.fn(),
    mandala: undefined
  }
})

const ALICE = '02' + 'a'.repeat(64)
const txid = (n: number) => n.toString(16).padStart(64, '0')

/** A listActions fake that pages `all` the way the wallet does. */
const pagedActions = (all: any[]) =>
  jest.fn(async ({ limit, offset }: { limit: number; offset: number }) => ({
    totalActions: all.length,
    actions: all.slice(offset, offset + limit)
  }))

const LUNCH = {
  txid: txid(1),
  satoshis: -500,
  labels: ['peerpay'],
  description: 'Lunch with Sam',
  created_at: '2026-09-15T10:00:00Z'
}
const RENT = {
  txid: txid(2),
  satoshis: -9000,
  labels: ['peerpay', ALICE],
  description: 'rent',
  created_at: '2026-09-15T09:00:00Z'
}
const SALARY = {
  txid: txid(3),
  satoshis: 90000,
  labels: [],
  description: 'September',
  created_at: '2026-09-15T08:00:00Z'
}
const APP = {
  txid: txid(4),
  satoshis: -20,
  labels: ['some-app'],
  description: 'Certificate',
  created_at: '2026-09-15T07:00:00Z'
}
const VAULT = {
  txid: txid(5),
  satoshis: -7000,
  labels: ['vault', 'vault-deposit'],
  description: 'Vault deposit',
  created_at: '2026-09-15T06:00:00Z'
}
const ALL = [LUNCH, RENT, SALARY, APP, VAULT]

const shown = (screen: ReturnType<typeof render>) =>
  ALL.filter(a => screen.queryByText(`row:${a.txid}`)).map(a => a.description)

const openFilter = async (screen: ReturnType<typeof render>) => {
  fireEvent.press(screen.getByLabelText('activity_filter'))
  await settle()
}

const typeSearch = async (screen: ReturnType<typeof render>, text: string) => {
  fireEvent.changeText(screen.getByPlaceholderText('activity_search_placeholder'), text)
  await settle()
}

describe('WalletHomeScreen activity filter', () => {
  beforeEach(() => {
    mockWallet.managers.permissionsManager.listActions = pagedActions(ALL)
  })

  test('the export button just says Export, and still tells a screen reader it is CSV', async () => {
    const screen = render(<WalletHomeScreen />)
    await settle()
    expect(screen.getByText('tx_export')).toBeTruthy()
    expect(screen.queryByText('tx_export_csv')).toBeNull()
    expect(screen.getByLabelText('tx_export_csv')).toBeTruthy()
  })

  test('is closed until the filter button is tapped, then opens with the search field focused and All chosen', async () => {
    const screen = render(<WalletHomeScreen />)
    await settle()
    expect(screen.queryByPlaceholderText('activity_search_placeholder')).toBeNull()
    await openFilter(screen)
    expect(screen.getByPlaceholderText('activity_search_placeholder').props.autoFocus).toBe(true)
    for (const chip of [
      'activity_filter_all',
      'tx_status_sent',
      'tx_status_received',
      'tx_status_spent',
      'tx_status_transferred'
    ]) {
      expect(screen.getByText(chip)).toBeTruthy()
    }
    expect(screen.getByLabelText('activity_filter_all').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true })
    )
    expect(shown(screen)).toEqual(ALL.map(a => a.description))
  })

  test('narrows the list to rows whose note matches as you type', async () => {
    const screen = render(<WalletHomeScreen />)
    await settle()
    await openFilter(screen)
    await typeSearch(screen, 'lun')
    expect(shown(screen)).toEqual(['Lunch with Sam'])
    await typeSearch(screen, 'LUNCH sam')
    expect(shown(screen)).toEqual(['Lunch with Sam'])
  })

  test("finds a payment by the saved contact's name or @handle", async () => {
    mockContactsStore.listContacts = jest.fn(async () => [
      { identityKey: ALICE, name: 'Alice Martin', cachedHandle: 'ally' }
    ])
    const screen = render(<WalletHomeScreen />)
    await settle()
    await openFilter(screen)
    expect(mockContactsStore.listContacts).toHaveBeenCalledWith(1)
    await typeSearch(screen, 'alice')
    expect(shown(screen)).toEqual(['rent'])
    await typeSearch(screen, '@ally')
    expect(shown(screen)).toEqual(['rent'])
  })

  test('a type chip keeps only rows that say that word', async () => {
    const screen = render(<WalletHomeScreen />)
    await settle()
    await openFilter(screen)
    fireEvent.press(screen.getByText('tx_status_received'))
    await settle()
    expect(shown(screen)).toEqual(['September'])
    fireEvent.press(screen.getByText('tx_status_sent'))
    await settle()
    expect(shown(screen)).toEqual(['Lunch with Sam', 'rent'])
    fireEvent.press(screen.getByText('tx_status_spent'))
    await settle()
    expect(shown(screen)).toEqual(['Certificate'])
    fireEvent.press(screen.getByText('tx_status_transferred'))
    await settle()
    expect(shown(screen)).toEqual(['Vault deposit'])
    expect(screen.getByLabelText('tx_status_transferred').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true })
    )
  })

  test('type and search combine', async () => {
    const screen = render(<WalletHomeScreen />)
    await settle()
    await openFilter(screen)
    fireEvent.press(screen.getByText('tx_status_sent'))
    await typeSearch(screen, 'rent')
    expect(shown(screen)).toEqual(['rent'])
    fireEvent.press(screen.getByText('tx_status_received'))
    await settle()
    expect(shown(screen)).toEqual([])
  })

  test('says nothing matched rather than "no transactions"', async () => {
    const screen = render(<WalletHomeScreen />)
    await settle()
    await openFilter(screen)
    await typeSearch(screen, 'zzzz')
    expect(shown(screen)).toEqual([])
    expect(screen.getByText('activity_filter_no_match')).toBeTruthy()
    expect(screen.queryByText('no_transactions')).toBeNull()
  })

  test('the clear button empties the search but keeps the panel open', async () => {
    const screen = render(<WalletHomeScreen />)
    await settle()
    await openFilter(screen)
    await typeSearch(screen, 'lunch')
    fireEvent.press(screen.getByLabelText('activity_search_clear'))
    await settle()
    expect(screen.getByPlaceholderText('activity_search_placeholder').props.value).toBe('')
    expect(shown(screen)).toEqual(ALL.map(a => a.description))
  })

  test('tapping the filter button again closes the panel and brings every row back', async () => {
    const screen = render(<WalletHomeScreen />)
    await settle()
    await openFilter(screen)
    fireEvent.press(screen.getByText('tx_status_received'))
    await typeSearch(screen, 'sept')
    expect(shown(screen)).toEqual(['September'])
    await openFilter(screen)
    expect(screen.queryByPlaceholderText('activity_search_placeholder')).toBeNull()
    expect(shown(screen)).toEqual(ALL.map(a => a.description))
    // Reopening starts clean: the old type and search did not linger.
    await openFilter(screen)
    expect(screen.getByPlaceholderText('activity_search_placeholder').props.value).toBe('')
    expect(screen.getByLabelText('activity_filter_all').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true })
    )
  })

  test('reaches into older history for a match the first page does not hold', async () => {
    const filler = Array.from({ length: 30 }, (_, i) => ({
      txid: txid(100 + i),
      satoshis: -1,
      labels: ['peerpay'],
      description: `coffee ${i}`,
      created_at: '2026-09-15T12:00:00Z'
    }))
    const old = { ...LUNCH, txid: txid(999), description: 'Old lunch', created_at: '2026-08-01T12:00:00Z' }
    const listActions = pagedActions([...filler, old])
    mockWallet.managers.permissionsManager.listActions = listActions
    const screen = render(<WalletHomeScreen />)
    await settle()
    expect(screen.queryByText(`row:${old.txid}`)).toBeNull()
    await openFilter(screen)
    await typeSearch(screen, 'old lunch')
    await settle()
    expect(listActions).toHaveBeenCalledWith(expect.objectContaining({ offset: 30 }), 'admin.test')
    expect(screen.getByText(`row:${old.txid}`)).toBeTruthy()
  })

  test('does not claim "no match" while older history is still being searched', async () => {
    const filler = Array.from({ length: 30 }, (_, i) => ({
      txid: txid(100 + i),
      satoshis: -1,
      labels: ['peerpay'],
      description: `coffee ${i}`,
      created_at: '2026-09-15T12:00:00Z'
    }))
    mockWallet.managers.permissionsManager.listActions = jest.fn(async ({ offset }: { offset: number }) =>
      offset === 0 ? { totalActions: 60, actions: filler } : new Promise(() => {})
    )
    const screen = render(<WalletHomeScreen />)
    await settle()
    await openFilter(screen)
    await typeSearch(screen, 'zzzz')
    expect(screen.queryByText('activity_filter_no_match')).toBeNull()
  })

  test('stops searching, rather than retrying in a loop, when an older page fails to load', async () => {
    const filler = Array.from({ length: 30 }, (_, i) => ({
      txid: txid(100 + i),
      satoshis: -1,
      labels: ['peerpay'],
      description: `coffee ${i}`,
      created_at: '2026-09-15T12:00:00Z'
    }))
    const listActions = jest.fn(async ({ offset }: { offset: number }) => {
      if (offset === 0) return { totalActions: 60, actions: filler }
      throw new Error('offline')
    })
    mockWallet.managers.permissionsManager.listActions = listActions
    const screen = render(<WalletHomeScreen />)
    await settle()
    await openFilter(screen)
    await typeSearch(screen, 'zzzz')
    for (let i = 0; i < 5; i++) await settle()
    expect(listActions.mock.calls.filter(([args]) => args.offset === 30)).toHaveLength(1)
    expect(screen.getByText('activity_filter_no_match')).toBeTruthy()
  })

  test('the filter button does nothing while there is no activity to filter', async () => {
    mockWallet.managers.permissionsManager.listActions = pagedActions([])
    const screen = render(<WalletHomeScreen />)
    await settle()
    expect(screen.getByLabelText('activity_filter').props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true })
    )
    fireEvent.press(screen.getByLabelText('activity_filter'))
    await settle()
    expect(screen.queryByPlaceholderText('activity_search_placeholder')).toBeNull()
  })
})
