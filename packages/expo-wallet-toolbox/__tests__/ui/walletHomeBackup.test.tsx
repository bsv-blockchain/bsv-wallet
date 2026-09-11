import React from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { backupAttestation } from '../../core/services/vault/backupAttestation'
import { WalletHomeScreen } from '../../ui/screens/WalletHomeScreen'
import { WalletConfigScreen } from '../../ui/screens/WalletConfigScreen'

const IDENTITY = '02' + 'a'.repeat(64)
const mockRouter = { push: jest.fn(), replace: jest.fn() }
const mockHasStoredIdentity = jest.fn()
const mockCreateMnemonic = jest.fn()
const mockGenerateMnemonic = jest.fn()
const mockBuild = jest.fn()
const mockGetMnemonic = jest.fn()
const mockGetRecoveredKey = jest.fn()
const mockClipboardWrite = jest.fn()
let mockSection: string | undefined
let mockSecretsReady = true
let mockWallet: any
let mockReminder: any
let mockAdvisory: any
let mockImportPrompt: any

jest.mock('@bsv/expo-wallet-toolbox', () => {
  const React = require('react')
  return {
    ...jest.requireActual('../../core/theme/tokens'),
    useTheme: () => ({ colors: {} }),
    useWallet: () => mockWallet,
    useLocalStorage: () => ({
      hasStoredIdentity: mockHasStoredIdentity,
      createMnemonic: mockCreateMnemonic,
      getMnemonic: mockGetMnemonic,
      getRecoveredKey: mockGetRecoveredKey,
      secretsReady: mockSecretsReady
    }),
    generateMnemonicWallet: (...args: unknown[]) => mockGenerateMnemonic(...args),
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
  useLocalSearchParams: () => ({ section: mockSection }),
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect])
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('@bsv/message-box-client', () => ({ PeerPayClient: jest.fn() }))
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
jest.mock('../../ui/components/wallet/BackupReminderSheet', () => ({
  BackupReminderSheet: (props: unknown) => { mockReminder = props; return null }
}))
jest.mock('../../ui/components/wallet/BiometricAdvisoryModal', () => ({
  BiometricAdvisoryModal: (props: unknown) => { mockAdvisory = props; return null }
}))
jest.mock('../../ui/components/wallet/ImportFromBackupPrompt', () => ({
  ImportFromBackupPrompt: (props: unknown) => { mockImportPrompt = props; return null }
}))
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
  return { ListRow: ({ label, onPress }: any) => React.createElement(Pressable, { onPress }, React.createElement(Text, {}, label)) }
})
jest.mock('../../ui/components/ui/GroupedList', () => ({ GroupedSection: ({ children }: any) => children }))
jest.mock('../../ui/components/pay/MessageBoxConfig', () => ({
  ConfigPanel: () => null,
  useMessageBoxConfig: () => ({ messageBoxUrl: 'https://test.invalid' })
}))
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: jest.fn() }))
jest.mock('../../ui/exportDatabases', () => ({ exportAllWalletDatabases: jest.fn() }))
jest.mock('../../ui/importDatabases', () => ({ importWalletDatabase: jest.fn() }))
jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: { setString: (...args: unknown[]) => mockClipboardWrite(...args) }
}))

beforeEach(async () => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  await AsyncStorage.clear()
  mockSecretsReady = true
  mockSection = undefined
  mockHasStoredIdentity.mockResolvedValue(true)
  mockCreateMnemonic.mockResolvedValue(true)
  mockGenerateMnemonic.mockReturnValue({ mnemonic: 'synthetic fresh phrase', identityKey: IDENTITY })
  mockGetMnemonic.mockResolvedValue('synthetic stored phrase')
  mockGetRecoveredKey.mockResolvedValue(null)
  mockClipboardWrite.mockResolvedValue(undefined)
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
    walletUserId: null,
    walletBuilt: true,
    walletBuilding: false,
    buildWalletFromMnemonic: mockBuild
  }
})

afterEach(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
})

async function renderHome() {
  const screen = render(<WalletHomeScreen />)
  await act(async () => {})
  return screen
}

it('keeps an upgraded wallet with unknown backup status out of onboarding', async () => {
  await renderHome()
  expect(mockReminder.visible).toBe(false)
  expect(mockGenerateMnemonic).not.toHaveBeenCalled()
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
  expect(mockRouter.push).not.toHaveBeenCalled()
})

it('opens the existing recovery controls when an explicitly pending wallet backs up', async () => {
  await backupAttestation.markPending(IDENTITY)
  await renderHome()
  expect(mockReminder.visible).toBe(true)

  act(() => mockReminder.onBackupNow())

  expect(mockRouter.push).toHaveBeenCalledWith('/auth/mnemonic?flow=backup')
  expect(mockReminder.visible).toBe(false)
  expect(mockGenerateMnemonic).not.toHaveBeenCalled()
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
})

it('does not warn a wallet whose backup has already been recorded', async () => {
  await backupAttestation.markPending(IDENTITY)
  await backupAttestation.set(IDENTITY, 'phrase')
  await renderHome()
  expect(mockReminder.visible).toBe(false)
})

it.each(['migration', 'building', 'locked'] as const)('never creates over a returning wallet during %s', async state => {
  mockWallet.managers.permissionsManager = null
  mockWallet.walletBuilt = false
  mockSecretsReady = state !== 'migration'
  mockWallet.walletBuilding = state === 'building'
  const screen = await renderHome()

  await act(async () => fireEvent.press(screen.getByText('pay_direction_pay')))

  expect(mockAdvisory.visible).toBe(false)
  expect(mockGenerateMnemonic).not.toHaveBeenCalled()
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
  expect(mockRouter.replace).not.toHaveBeenCalled()
})

it.each(['migration', 'building'] as const)('waits until %s finishes before deciding whether to offer import', async state => {
  mockWallet.managers.permissionsManager = null
  mockWallet.walletBuilt = false
  mockSecretsReady = state !== 'migration'
  mockWallet.walletBuilding = state === 'building'
  // A presence read during migration could observe the handoff between the
  // legacy and encrypted stores. It must not make an empty-wallet decision.
  mockHasStoredIdentity.mockResolvedValue(false)
  const screen = await renderHome()
  expect(mockHasStoredIdentity).not.toHaveBeenCalled()
  expect(mockImportPrompt.visible).toBe(false)

  mockHasStoredIdentity.mockResolvedValue(true)
  mockSecretsReady = true
  mockWallet.walletBuilding = false
  await act(async () => screen.rerender(<WalletHomeScreen />))

  expect(mockHasStoredIdentity).toHaveBeenCalledTimes(1)
  expect(mockImportPrompt.visible).toBe(false)
})

it('discards an empty-wallet check if another build begins before the read finishes', async () => {
  mockWallet.managers.permissionsManager = null
  mockWallet.walletBuilt = false
  let finishRead!: (exists: boolean) => void
  mockHasStoredIdentity.mockReturnValue(new Promise<boolean>(resolve => { finishRead = resolve }))
  const screen = await renderHome()

  mockWallet.walletBuilding = true
  await act(async () => screen.rerender(<WalletHomeScreen />))
  await act(async () => finishRead(false))
  expect(mockImportPrompt.visible).toBe(false)

  mockHasStoredIdentity.mockResolvedValue(true)
  mockWallet.walletBuilding = false
  await act(async () => screen.rerender(<WalletHomeScreen />))
  expect(mockImportPrompt.visible).toBe(false)
})

it('offers import after a settled startup confirms the device has no identity', async () => {
  mockWallet.managers.permissionsManager = null
  mockWallet.walletBuilt = false
  mockHasStoredIdentity.mockResolvedValue(false)
  await renderHome()

  expect(mockImportPrompt.visible).toBe(true)
})

it('rechecks stored identity after the advisory before generating any keys', async () => {
  mockWallet.managers.permissionsManager = null
  mockWallet.walletBuilt = false
  mockHasStoredIdentity.mockResolvedValue(false)
  const screen = await renderHome()
  await act(async () => fireEvent.press(screen.getByText('pay_direction_pay')))
  expect(mockAdvisory.visible).toBe(true)

  mockHasStoredIdentity.mockResolvedValue(true)
  act(() => mockAdvisory.onContinue())
  await waitFor(() => expect(mockAdvisory.visible).toBe(false))

  expect(mockGenerateMnemonic).not.toHaveBeenCalled()
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
  expect(mockRouter.replace).not.toHaveBeenCalled()
})

it('records a pending reminder only for a successfully stored new identity', async () => {
  mockWallet.managers.permissionsManager = null
  mockWallet.walletBuilt = false
  mockHasStoredIdentity.mockResolvedValue(false)
  const screen = await renderHome()
  await act(async () => fireEvent.press(screen.getByText('pay_direction_pay')))
  act(() => mockAdvisory.onContinue())
  await waitFor(() => expect(mockBuild).toHaveBeenCalledWith('synthetic fresh phrase'))

  expect(mockCreateMnemonic).toHaveBeenCalledTimes(1)
  expect(await backupAttestation.needsReminder(IDENTITY)).toBe(true)
})

it('builds the saved wallet when pending-backup metadata cannot be written', async () => {
  mockWallet.managers.permissionsManager = null
  mockWallet.walletBuilt = false
  mockHasStoredIdentity.mockResolvedValue(false)
  mockCreateMnemonic.mockImplementationOnce(async () => {
    mockHasStoredIdentity.mockResolvedValue(true)
    return true
  })
  const pending = jest.spyOn(backupAttestation, 'markPending').mockRejectedValueOnce(new Error('AsyncStorage unavailable'))
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const screen = await renderHome()
    await act(async () => fireEvent.press(screen.getByText('pay_direction_pay')))
    act(() => mockAdvisory.onContinue())
    await waitFor(() => expect(mockBuild).toHaveBeenCalledWith('synthetic fresh phrase'))

    // A subsequent tap must keep using the saved identity, even if the mocked
    // wallet manager has not appeared yet.
    await act(async () => fireEvent.press(screen.getByText('pay_direction_pay')))
    expect(mockCreateMnemonic).toHaveBeenCalledTimes(1)
    expect(mockGenerateMnemonic).toHaveBeenCalledTimes(1)
    expect(mockAdvisory.visible).toBe(false)
  } finally {
    pending.mockRestore()
    warn.mockRestore()
  }
})

it('offers one backup action in advanced settings and opens the existing mnemonic backup flow', async () => {
  mockSection = 'backup'
  await backupAttestation.markPending(IDENTITY)
  const screen = render(<WalletConfigScreen />)
  await act(async () => {})
  expect(screen.getAllByText('backup_wallet_keys')).toHaveLength(1)
  expect(screen.queryByText('copy_secret_words')).toBeNull()
  expect(screen.queryByText('print_recovery_keys')).toBeNull()

  await act(async () => fireEvent.press(screen.getByText('backup_wallet_keys')))

  expect(mockRouter.push).toHaveBeenCalledTimes(1)
  expect(mockRouter.push).toHaveBeenCalledWith('/auth/mnemonic?flow=backup')
  expect(mockGetMnemonic).not.toHaveBeenCalled()
  expect(mockGetRecoveredKey).not.toHaveBeenCalled()
  expect(mockClipboardWrite).not.toHaveBeenCalled()
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
  expect(mockGenerateMnemonic).not.toHaveBeenCalled()
  expect(await backupAttestation.needsReminder(IDENTITY)).toBe(true)
  expect(await backupAttestation.get(IDENTITY)).toBeNull()
})
