/**
 * Home, with and without a stablecoin.
 *
 * The two facts this pins are the ones a holder reads first:
 *
 *  · a wallet that has never held a token renders EXACTLY today's screen —
 *    "You have", no Balances block, no extra row;
 *  · the moment one is held, the hero's label becomes "Your BSV", because the
 *    hero is the fee balance and must not read as the answer to "how much money
 *    do I have" — but (2026-09-15 maintainer decision) there is no Balances
 *    block or per-asset sheet at all any more: holdings are visible in the Pay
 *    asset picker and in the activity list, not on Home.
 *
 * The barrel mock mirrors walletHomeVaultGate.test.tsx — WalletHomeScreen pulls
 * in the whole wallet surface — plus the Mandala runtime on the context, which
 * is where `useMandala()` reads it from.
 */
import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'
import { WalletHomeScreen } from '../../ui/screens/WalletHomeScreen'
import { balanceOf, makeFakeMandala, settlementRow, USDX } from '../__mocks__/fakeMandalaRuntime'

const IDENTITY = '02' + 'a'.repeat(64)
const mockRouter = { push: jest.fn(), replace: jest.fn() }
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
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join('|')}` : key
  })
}))
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
    buildWalletFromMnemonic: jest.fn(),
    mandala: undefined
  }
})

describe('WalletHomeScreen without stablecoins', () => {
  test('is today\'s screen: "You have", and no Balances block at all', async () => {
    const screen = render(<WalletHomeScreen />)
    await settle()
    expect(screen.getByText('wallet_balance_you_have')).toBeTruthy()
    expect(screen.queryByText('wallet_balance_your_bsv')).toBeNull()
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
  test('swaps the hero label, with no Balances block anywhere on the screen', async () => {
    mockWallet.mandala = makeFakeMandala({ balances: [balanceOf()] })
    const screen = render(<WalletHomeScreen />)
    await settle()
    expect(screen.getByText('wallet_balance_your_bsv')).toBeTruthy()
    expect(screen.queryByText('wallet_balance_you_have')).toBeNull()
    // No Balances block, no per-asset row, no asset sheet (2026-09-15
    // maintainer decision) — holdings live in the Pay asset picker instead.
    expect(screen.queryByText('token_balances_header')).toBeNull()
    expect(screen.queryByText('Acme Dollar')).toBeNull()
    expect(screen.queryByLabelText('1,240.00 USDX')).toBeNull()
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
