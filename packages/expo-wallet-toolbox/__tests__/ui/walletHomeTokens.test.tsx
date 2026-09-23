/**
 * Home, with and without a stablecoin.
 *
 * The two facts this pins are the ones a holder reads first:
 *
 *  · a wallet that has never held a token renders EXACTLY today's screen —
 *    "You have", no Balances block, no extra row;
 *  · the moment one is held, a "BSV ⌄" pill appears in the top bar — a coin
 *    switcher (design 4a, 2026-09-16). Its dropdown lists BSV and every held
 *    token; picking one swaps the hero figure, filters the activity list to
 *    that coin, and arms Pay / Get paid with it, so the Pay screen never has
 *    to ask the asset question again.
 *
 * The barrel mock mirrors walletHomeVaultGate.test.tsx — WalletHomeScreen pulls
 * in the whole wallet surface — plus the Mandala runtime on the context, which
 * is where `useMandala()` reads it from.
 */
import React from 'react'
import { act, fireEvent, render, within } from '@testing-library/react-native'
import { WalletHomeScreen } from '../../ui/screens/WalletHomeScreen'
import { activityRow, balanceOf, EURX, makeFakeMandala, settlementRow, USDX } from '../__mocks__/fakeMandalaRuntime'

const IDENTITY = '02' + 'a'.repeat(64)
const mockRouter = { push: jest.fn(), replace: jest.fn() }
let mockWallet: any

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
jest.mock('@bsv/wallet-toolbox-mobile', () => ({ sdk: { specOpWalletBalance: 'specOpWalletBalance' } }))
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
  return ({ action, token }: any) =>
    React.createElement(Text, {}, `row:${action.txid}:${token ? token.amount.unit : 'BSV'}`)
})
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
    storage: null,
    txStatusVersion: 0,
    walletUserId: null,
    walletBuilt: true,
    walletBuilding: false,
    buildWalletFromMnemonic: jest.fn(),
    mandala: undefined
  }
})

describe('WalletHomeScreen without stablecoins', () => {
  test('is today\'s screen: "You have", and no Balances block at all', async () => {
    const screen = render(<WalletHomeScreen />)
    await settle()
    expect(screen.getByText('wallet_balance_you_have')).toBeTruthy()
    expect(screen.queryByLabelText('wallet_coin_switcher')).toBeNull()
    expect(screen.queryByText('token_balances_header')).toBeNull()
  })

  test('is unchanged when a runtime exists but nothing is held', async () => {
    mockWallet.mandala = makeFakeMandala({ balances: [] })
    const screen = render(<WalletHomeScreen />)
    await settle()
    expect(screen.getByText('wallet_balance_you_have')).toBeTruthy()
    expect(screen.queryByText('token_balances_header')).toBeNull()
  })
})

describe('WalletHomeScreen holding a stablecoin', () => {
  test('swaps the hero label into a closed coin switcher: no drawer, no per-asset rows, until tapped', async () => {
    mockWallet.mandala = makeFakeMandala({ balances: [balanceOf()] })
    const screen = render(<WalletHomeScreen />)
    await settle()
    expect(within(screen.getByLabelText('wallet_coin_switcher')).getByText('BSV')).toBeTruthy()
    expect(screen.queryByText('wallet_balance_you_have')).toBeNull()
    expect(screen.queryByText('token_balances_header')).toBeNull()
    expect(screen.queryByText('Acme Dollar')).toBeNull()
  })

  test('the drawer lists BSV and every held coin, and picking one swaps the hero to that figure', async () => {
    mockWallet.mandala = makeFakeMandala({ balances: [balanceOf(), balanceOf(EURX, 5000)] })
    const screen = render(<WalletHomeScreen />)
    await settle()
    fireEvent.press(screen.getByLabelText('wallet_coin_switcher'))
    expect(screen.getByText('Acme Dollar')).toBeTruthy()
    expect(screen.getByText('Euro Coin')).toBeTruthy()
    expect(screen.getByLabelText('1,240.00 USDX')).toBeTruthy()
    fireEvent.press(screen.getByText('Acme Dollar'))
    await settle()
    expect(within(screen.getByLabelText('wallet_coin_switcher')).getByText('USDX')).toBeTruthy()
    // The hero is the token figure; the line under it is the asset's full
    // name, never a conversion — the wallet has no price for a token (ux §6.1).
    // With a token held the hero is inert (no denomination to flip to), so it
    // carries no label — only the figure as its accessibility value.
    expect(
      screen
        .UNSAFE_getAllByProps({ disabled: true })
        .some(node => node.props.accessibilityValue?.text === '1,240.00 USDX')
    ).toBe(true)
    expect(screen.getAllByText('Acme Dollar').length).toBeGreaterThan(0)
    expect(screen.queryByText('0 BSV   ·   0')).toBeNull()
    // The drawer closed on the pick.
    expect(screen.queryByText('Euro Coin')).toBeNull()
  })

  test('Pay and Get paid carry the chosen coin so the Pay screen never asks again', async () => {
    mockWallet.mandala = makeFakeMandala({ balances: [balanceOf()] })
    const screen = render(<WalletHomeScreen />)
    await settle()
    fireEvent.press(screen.getByText('pay_direction_pay'))
    expect(mockRouter.push).toHaveBeenLastCalledWith('/pay')
    fireEvent.press(screen.getByLabelText('wallet_coin_switcher'))
    fireEvent.press(screen.getByText('Acme Dollar'))
    await settle()
    fireEvent.press(screen.getByText('pay_direction_pay'))
    expect(mockRouter.push).toHaveBeenLastCalledWith(`/pay?asset=${encodeURIComponent(USDX.assetId)}`)
    fireEvent.press(screen.getByText('pay_direction_receive'))
    expect(mockRouter.push).toHaveBeenLastCalledWith(`/pay?direction=get&asset=${encodeURIComponent(USDX.assetId)}`)
  })

  test('falls back to BSV when the chosen coin is no longer held', async () => {
    const runtime = makeFakeMandala({ balances: [balanceOf()] })
    mockWallet.mandala = runtime
    const screen = render(<WalletHomeScreen />)
    await settle()
    fireEvent.press(screen.getByLabelText('wallet_coin_switcher'))
    fireEvent.press(screen.getByText('Acme Dollar'))
    await settle()
    expect(within(screen.getByLabelText('wallet_coin_switcher')).getByText('USDX')).toBeTruthy()
    runtime.balances.mockResolvedValue([])
    await act(async () => runtime.emit())
    await settle()
    expect(screen.getByText('wallet_balance_you_have')).toBeTruthy()
  })

  test('the activity list follows the coin: BSV hides token rows, a token shows only its own', async () => {
    const BSV_TX = '1'.repeat(64)
    const USDX_TX = '2'.repeat(64)
    const EURX_TX = '3'.repeat(64)
    mockWallet.storage = { chain: 'main' }
    mockWallet.managers.permissionsManager.listActions = jest.fn(async () => ({
      totalActions: 3,
      actions: [
        { txid: BSV_TX, satoshis: 100, labels: [], created_at: '2026-09-15T10:00:00Z' },
        { txid: USDX_TX, satoshis: -50, labels: ['mandala'], created_at: '2026-09-15T09:00:00Z' },
        { txid: EURX_TX, satoshis: -50, labels: ['mandala'], created_at: '2026-09-15T08:00:00Z' }
      ]
    }))
    mockWallet.mandala = makeFakeMandala({
      balances: [balanceOf(), balanceOf(EURX, 5000)],
      activity: [
        activityRow({ txid: USDX_TX, asset: USDX, role: 'sent' }),
        activityRow({ txid: EURX_TX, asset: EURX, role: 'sent' })
      ]
    })
    const screen = render(<WalletHomeScreen />)
    await settle()
    expect(screen.getByText(`row:${BSV_TX}:BSV`)).toBeTruthy()
    expect(screen.queryByText(`row:${USDX_TX}:USDX`)).toBeNull()
    expect(screen.queryByText(`row:${EURX_TX}:EURX`)).toBeNull()

    fireEvent.press(screen.getByLabelText('wallet_coin_switcher'))
    fireEvent.press(screen.getByText('Euro Coin'))
    await settle()
    expect(screen.getByText(`row:${EURX_TX}:EURX`)).toBeTruthy()
    expect(screen.queryByText(`row:${BSV_TX}:BSV`)).toBeNull()
    expect(screen.queryByText(`row:${USDX_TX}:USDX`)).toBeNull()
  })

  test('says which coin has no activity yet, rather than "no transactions"', async () => {
    mockWallet.storage = { chain: 'main' }
    mockWallet.managers.permissionsManager.listActions = jest.fn(async () => ({
      totalActions: 1,
      actions: [{ txid: '1'.repeat(64), satoshis: 100, labels: [], created_at: '2026-09-15T10:00:00Z' }]
    }))
    mockWallet.mandala = makeFakeMandala({ balances: [balanceOf()] })
    const screen = render(<WalletHomeScreen />)
    await settle()
    fireEvent.press(screen.getByLabelText('wallet_coin_switcher'))
    fireEvent.press(screen.getByText('Acme Dollar'))
    await settle()
    expect(screen.getByText('wallet_activity_empty_asset:USDX')).toBeTruthy()
    expect(screen.queryByText('no_transactions')).toBeNull()
  })

  test('surfaces a payment that has been waiting to settle', async () => {
    mockWallet.mandala = makeFakeMandala({ balances: [balanceOf()], stuck: [settlementRow()] })
    const screen = render(<WalletHomeScreen />)
    await settle()
    expect(screen.getByText('token_attention_one:Acme Bank')).toBeTruthy()
  })

  test('says how many are waiting when it cannot name one issuer', async () => {
    mockWallet.mandala = makeFakeMandala({
      balances: [balanceOf()],
      stuck: [settlementRow(), settlementRow({ txid: 'c'.repeat(64) })]
    })
    const screen = render(<WalletHomeScreen />)
    await settle()
    expect(screen.getByText('token_attention_many:2')).toBeTruthy()
  })

  test('routes the stuck-settlement badge to Pay with that asset, not to a sheet', async () => {
    mockWallet.mandala = makeFakeMandala({ balances: [balanceOf()], stuck: [settlementRow()] })
    const screen = render(<WalletHomeScreen />)
    await settle()
    fireEvent.press(screen.getByText('token_attention_one:Acme Bank'))
    expect(mockRouter.push).toHaveBeenCalledWith(`/pay?asset=${encodeURIComponent(USDX.assetId)}`)
  })
})
