import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'

const mockT = (k: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() }
const mockShowAlert = jest.fn()
const mockShowToast = jest.fn()
const mockDeposit = jest.fn()
const mockWithdraw = jest.fn()
const mockPreview = jest.fn()
const mockRefresh = jest.fn()
const mockGetVaultBalance = jest.fn()
let mockParams: { direction?: string } = {}
let mockMeta: unknown = null
let mockBalance: number | null = 0
let mockVaultEnabled = true
let mockBackupOn = true
let mockBackupUrl = 'https://backup.example.test'
let mockWallet: any
const mockIsBackupPushEnabled = jest.fn(async () => mockBackupOn)

jest.mock('@bsv/expo-wallet-toolbox', () => {
  const React = require('react')
  return {
    ...jest.requireActual('../../core/theme/tokens'),
    useTheme: () => ({ colors: {} }),
    i18n: { t: (k: string, o?: Record<string, unknown>) => mockT(k, o) },
    useWallet: () => mockWallet,
    ExchangeRateContext: React.createContext({ satoshisPerUSD: 0, usdToFiat: {} }),
    formatAmount: (sats: number) => `${sats.toLocaleString('en-US')} sats`,
    VaultError: jest.requireActual('../../core/services/vault/types').VaultError,
    vaultStore: { getMeta: async () => mockMeta },
    depositToVault: (...a: unknown[]) => mockDeposit(...a),
    previewVaultWithdrawal: (...a: unknown[]) => mockPreview(...a),
    withdrawFromVault: (...a: unknown[]) => mockWithdraw(...a),
    getVaultBalance: (...a: unknown[]) => mockGetVaultBalance(...a),
    sounds: { vaultDeposit: jest.fn(), vaultWithdraw: jest.fn() },
    isVaultEnabled: () => mockVaultEnabled,
    isBackupPushEnabled: () => mockIsBackupPushEnabled(),
    getBackupUrl: () => mockBackupUrl,
    getOnline: async () => true,
    estimateRelockFee: () => 3080,
    R1C_LOCK_LEN: () => 27881,
    VAULT_DEPOSIT_MIN: 100_000,
    VAULT_MAX_KEYS: 5,
    haptics: { tap: jest.fn(), confirm: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() }
  }
})
jest.mock('expo-router', () => ({ router: mockRouter, useLocalSearchParams: () => mockParams, useFocusEffect: () => {} }))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  const PressableScaleMock = ({ children, onPress, ...props }: any) =>
    React.createElement(Pressable, { onPress, ...props }, children)
  PressableScaleMock.displayName = 'PressableScaleMock'
  return PressableScaleMock
})
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: (...a: unknown[]) => mockShowAlert(...a) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: (...a: unknown[]) => mockShowToast(...a) }))
jest.mock('../../ui/components/wallet/AmountInput', () => {
  const React = require('react')
  const { TextInput } = require('react-native')
  return {
    SEND_MAX_VALUE: '2099999999999999',
    AmountInput: ({ value, onChangeText }: any) => React.createElement(TextInput, { testID: 'amount', value, onChangeText })
  }
})
jest.mock('../../ui/components/wallet/AmountDisplay', () => {
  const React = require('react')
  const { Text } = require('react-native')
  return { __esModule: true, default: ({ children }: any) => React.createElement(Text, null, `${children} sats`) }
})
jest.mock('../../ui/hooks/useVaultBalance', () => ({
  useVaultBalance: () => ({ balance: mockBalance, loading: false, refresh: mockRefresh })
}))

import { VaultTransferScreen } from '../../ui/screens/VaultTransferScreen'
import { VaultError } from '../../core/services/vault/types'

const PUB = (c: string) => '02' + c.repeat(64)
const key = (n: number, nickname: string, c: string) => ({
  serial: `1234000${n}`,
  slot: 0x82,
  pubkey: PUB(c),
  nickname,
  enrolledAt: 1_700_000_000_000 + n
})
const META = { v: 5, createdAt: 1, lastUsedSerial: '12340002', keys: [key(1, 'Desk', 'a'), key(2, 'Safe', 'b')] }
const OK_RESULT = { txid: 'tx', cappedInputs: 0, unreachable: { count: 0, satoshis: 0, keys: [] } }
/** A preview in which the chosen key can select `selectedTotal`. */
const previewOf = (selectedTotal: number, over: Record<string, unknown> = {}) => ({
  selectedTotal,
  cappedInputs: 0,
  unreachable: { count: 0, satoshis: 0, keys: [] },
  ...over
})

const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
  })
}

async function renderTransfer(direction: 'deposit' | 'withdraw') {
  mockParams = { direction }
  const screen = render(<VaultTransferScreen />)
  await settle()
  return screen
}

async function typeAndRun(screen: ReturnType<typeof render>, amount: string, cta: string) {
  fireEvent.changeText(screen.getByTestId('amount'), amount)
  await act(async () => fireEvent.press(screen.getByText(cta)))
  await settle()
}

beforeEach(() => {
  jest.clearAllMocks()
  mockMeta = META
  mockBalance = 0
  mockVaultEnabled = true
  mockBackupOn = true
  mockBackupUrl = 'https://backup.example.test'
  mockDeposit.mockReset().mockResolvedValue({ txid: 'd' })
  mockWithdraw.mockReset().mockResolvedValue(OK_RESULT)
  // Default: the chosen key can select the whole balance. Remainder tests
  // set the preview explicitly — the rule is computed from it, not the balance.
  mockPreview.mockReset().mockImplementation(async () => previewOf(mockBalance ?? 0))
  // Rejects by default (rather than resolving to some arbitrary figure) so an
  // unmocked call fails fast into run()'s catch instead of silently mismatching
  // the post-withdrawal balance-settle loop and burning real setTimeout delays
  // the test harness's settle() (a single setImmediate flush) never waits out.
  // Tests that need the settle loop to complete give it the exact expected
  // figure with mockResolvedValueOnce so it matches — and returns — first try.
  mockGetVaultBalance.mockReset().mockRejectedValue(new Error('getVaultBalance not mocked for this test'))
  mockIsBackupPushEnabled.mockReset().mockImplementation(async () => mockBackupOn)
  mockShowAlert.mockReset()
  mockWallet = {
    managers: { permissionsManager: { createAction: jest.fn() } },
    adminOriginator: 'admin.test',
    storage: null,
    settings: { currency: 'BSV' }
  }
})

describe('deposit', () => {
  test('renders the floor and fee line', async () => {
    const screen = await renderTransfer('deposit')
    expect(
      screen.getByText('vault_floor_line:{"floorDisplay":"100,000 sats","floorSats":"100,000","feeDisplay":"3,080 sats"}')
    ).toBeTruthy()
    expect(screen.getByText('vault_deposit_sub')).toBeTruthy()
    expect(screen.queryByText('vault_choose_key')).toBeNull()
  })

  test('the CTA is inert below the floor', async () => {
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '99999', 'vault_deposit_cta')
    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockShowAlert).not.toHaveBeenCalled()
  })

  test('a first deposit confirms with the key names, then deposits without a reason string', async () => {
    mockShowAlert.mockResolvedValueOnce('deposit')
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'vault_first_deposit_title',
        message: 'vault_first_deposit_body:{"amount":"150,000 sats","count":2,"names":"Desk · …0001, Safe · …0002"}'
      })
    )
    expect(mockDeposit).toHaveBeenCalledTimes(1)
    expect(mockDeposit.mock.calls[0].slice(0, 3)).toEqual([mockWallet.managers.permissionsManager, 'admin.test', 150000])
    expect(mockDeposit.mock.calls[0]).toHaveLength(4)
    expect(mockShowToast).toHaveBeenCalledWith('vault_deposit_done', { type: 'success' })
    expect(mockRefresh).toHaveBeenCalled()
    expect(mockRouter.back).toHaveBeenCalled()
  })

  test('cancelling the first-deposit confirm deposits nothing', async () => {
    mockShowAlert.mockResolvedValueOnce('cancel')
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  test('a later deposit skips the confirm', async () => {
    mockBalance = 500_000
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(mockShowAlert).not.toHaveBeenCalled()
    expect(mockDeposit).toHaveBeenCalledTimes(1)
  })

  test('a double tap while the backup precheck is in flight deposits only once', async () => {
    mockBalance = 500_000
    let resolveBackup: (v: boolean) => void = () => {}
    mockIsBackupPushEnabled.mockImplementationOnce(
      () => new Promise<boolean>(resolve => { resolveBackup = resolve })
    )
    const screen = await renderTransfer('deposit')
    fireEvent.changeText(screen.getByTestId('amount'), '200000')
    await act(async () => {
      fireEvent.press(screen.getByText('vault_deposit_cta'))
      fireEvent.press(screen.getByText('vault_deposit_cta'))
    })
    await act(async () => {
      resolveBackup(true)
      await new Promise(r => setImmediate(r))
    })
    await settle()
    expect(mockIsBackupPushEnabled).toHaveBeenCalledTimes(1)
    expect(mockDeposit).toHaveBeenCalledTimes(1)
  })

  test('backup off: explains the recovery records, opens backup settings, and deposits nothing', async () => {
    mockBackupOn = false
    mockShowAlert.mockResolvedValueOnce('settings')
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(mockShowAlert).toHaveBeenCalledWith({
      title: 'vault_backup_off_title',
      message: 'vault_backup_off_body',
      buttons: [
        { text: 'vault_backup_off_cta', key: 'settings' },
        { text: 'vault_cancel', key: 'cancel', style: 'cancel' }
      ]
    })
    expect(mockRouter.push).toHaveBeenCalledWith('/wallet-config?section=backup')
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  test('no configured backup service: explains the requirement without offering an unusable settings route', async () => {
    mockBackupUrl = ''
    mockShowAlert.mockResolvedValueOnce('ok')
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(mockShowAlert).toHaveBeenCalledWith(expect.objectContaining({
      buttons: [{ text: 'vault_ok', key: 'ok' }]
    }))
    expect(mockIsBackupPushEnabled).not.toHaveBeenCalled()
    expect(mockRouter.push).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  test('a service backup-off refusal lands on the same alert', async () => {
    mockBalance = 500_000
    mockDeposit.mockRejectedValueOnce(new VaultError('backup-off'))
    mockShowAlert.mockResolvedValueOnce('cancel')
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(mockShowAlert).toHaveBeenCalledWith(expect.objectContaining({ title: 'vault_backup_off_title' }))
    expect(screen.queryByText('vault_err_backup_off')).toBeNull()
  })

  test('flag off: not-released copy inline and an inert CTA', async () => {
    mockVaultEnabled = false
    const screen = await renderTransfer('deposit')
    expect(screen.getByText('vault_not_released_body')).toBeTruthy()
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  test('a service error shows its copy inline', async () => {
    mockBalance = 500_000
    mockDeposit.mockRejectedValueOnce(new VaultError('requires-online'))
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(screen.getByText('vault_err_requires_online')).toBeTruthy()
  })
})

describe('withdraw', () => {
  test('shows the key chooser with the last-used key selected', async () => {
    mockBalance = 500_000
    const screen = await renderTransfer('withdraw')
    expect(screen.getByText('vault_choose_key')).toBeTruthy()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect(radios[1].props.accessibilityState).toEqual({ selected: true })
  })

  test('an unknown balance keeps the CTA inert even with a key chosen and a valid amount', async () => {
    mockBalance = null
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '50000', 'vault_withdraw_cta')
    expect(mockWithdraw).not.toHaveBeenCalled()
  })

  test('private backup off does not block withdrawing everything without Vault change', async () => {
    mockBalance = 500_000
    mockBackupOn = false
    mockGetVaultBalance.mockResolvedValueOnce(0)
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '2099999999999999', 'vault_withdraw_cta')
    expect(mockPreview).toHaveBeenCalledWith(mockWallet.managers.permissionsManager, 'admin.test', '12340002', 'all')
    expect(mockWithdraw.mock.calls[0][2]).toBe('all')
    expect(mockIsBackupPushEnabled).not.toHaveBeenCalled()
    expect(mockShowAlert).not.toHaveBeenCalled()
  })

  test('backup-off while preserving a withdrawal remainder opens backup settings', async () => {
    mockBalance = 500_000
    mockWithdraw.mockRejectedValueOnce(new VaultError('backup-off'))
    mockShowAlert.mockResolvedValueOnce('settings')
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '100000', 'vault_withdraw_cta')
    expect(mockShowAlert).toHaveBeenCalledWith(expect.objectContaining({ title: 'vault_backup_off_title' }))
    expect(mockRouter.push).toHaveBeenCalledWith('/wallet-config?section=backup')
    expect(mockRouter.back).not.toHaveBeenCalled()
  })

  test('passes the chosen serial to withdrawFromVault, and follows a change of choice', async () => {
    mockBalance = 500_000
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '50000', 'vault_withdraw_cta')
    // The preview runs first, for the same key and amount, before anything is tapped.
    expect(mockPreview).toHaveBeenCalledTimes(1)
    expect(mockPreview.mock.calls[0]).toEqual([mockWallet.managers.permissionsManager, 'admin.test', '12340002', 50000])
    expect(mockWithdraw).toHaveBeenCalledTimes(1)
    expect(mockWithdraw.mock.calls[0].slice(0, 5)).toEqual([
      mockWallet.managers.permissionsManager,
      'admin.test',
      50000,
      'vault_withdraw_reason:{"amount":50000}',
      '12340002'
    ])
    expect(mockShowToast).toHaveBeenCalledWith('vault_withdraw_done', { type: 'success' })

    mockRouter.back.mockClear()
    fireEvent.press(screen.getByText('Desk · …0001'))
    await typeAndRun(screen, '50000', 'vault_withdraw_cta')
    expect(mockWithdraw.mock.calls[1][4]).toBe('12340001')
  })

  test('a remainder below the floor confirms; Withdraw everything runs with all', async () => {
    mockBalance = 150_000
    mockPreview.mockResolvedValueOnce(previewOf(150_000))
    mockShowAlert.mockResolvedValueOnce('all')
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '80000', 'vault_withdraw_cta')
    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'vault_remainder_title',
        message: 'vault_remainder_body:{"amount":"80,000 sats","remainder":"70,000 sats"}'
      })
    )
    expect(mockShowAlert.mock.calls[0][0].buttons.map((b: any) => b.text)).toEqual(['vault_remainder_all', 'vault_remainder_change'])
    expect(mockWithdraw.mock.calls[0][2]).toBe('all')
    expect(mockWithdraw.mock.calls[0][3]).toBe('vault_withdraw_reason:{"amount":150000}')
  })

  test('Change amount on the remainder confirm withdraws nothing', async () => {
    mockBalance = 150_000
    mockPreview.mockResolvedValueOnce(previewOf(150_000))
    mockShowAlert.mockResolvedValueOnce('change')
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '80000', 'vault_withdraw_cta')
    expect(mockWithdraw).not.toHaveBeenCalled()
  })

  test('a remainder at or above the floor needs no confirm', async () => {
    mockBalance = 200_000
    mockPreview.mockResolvedValueOnce(previewOf(200_000))
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '100000', 'vault_withdraw_cta')
    expect(mockShowAlert).not.toHaveBeenCalled()
    expect(mockWithdraw.mock.calls[0][2]).toBe(100000)
  })

  test('the remainder is measured against the CHOSEN key\'s selectable total, not the balance: vault 300,000, key reaches 200,000, withdraw 150,000 → confirm, and Withdraw everything runs with all', async () => {
    // Spec §4.2 step 4. Against the balance the remainder would be 150,000
    // (no prompt); the service folds against the key's 200,000, so 50,000
    // would silently move — the confirmation must fire.
    mockBalance = 300_000
    mockPreview.mockResolvedValueOnce(
      previewOf(200_000, { unreachable: { count: 1, satoshis: 100_000, keys: [{ serial: '12340001', pubkey: PUB('a') }] } })
    )
    mockShowAlert.mockResolvedValueOnce('all')
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '150000', 'vault_withdraw_cta')
    expect(mockPreview).toHaveBeenCalledWith(mockWallet.managers.permissionsManager, 'admin.test', '12340002', 150000)
    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'vault_remainder_title',
        message: 'vault_remainder_body:{"amount":"150,000 sats","remainder":"50,000 sats"}'
      })
    )
    expect(mockWithdraw).toHaveBeenCalledTimes(1)
    expect(mockWithdraw.mock.calls[0][2]).toBe('all')
    expect(mockWithdraw.mock.calls[0][4]).toBe('12340002')
  })

  test('no confirm when the chosen key\'s selectable total leaves a remainder at the floor, whatever the balance', async () => {
    mockBalance = 300_000
    mockPreview.mockResolvedValueOnce(previewOf(250_000))
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '150000', 'vault_withdraw_cta')
    expect(mockShowAlert).not.toHaveBeenCalled()
    expect(mockWithdraw.mock.calls[0][2]).toBe(150000)
  })

  test('Max previews with all and never asks about a remainder', async () => {
    mockBalance = 300_000
    mockPreview.mockResolvedValueOnce(previewOf(200_000))
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '2099999999999999', 'vault_withdraw_cta')
    expect(mockPreview.mock.calls[0][3]).toBe('all')
    expect(mockShowAlert).not.toHaveBeenCalled()
    expect(mockWithdraw.mock.calls[0][2]).toBe('all')
  })

  test('a preview refusal shows inline like a run-time error, before any withdrawal — key-cannot-cover names the key and the figures', async () => {
    mockBalance = 500_000
    const err = new VaultError('key-cannot-cover') as VaultError & { details?: unknown }
    err.details = { reachable: 200_000, total: 500_000 }
    mockPreview.mockRejectedValueOnce(err)
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '300000', 'vault_withdraw_cta')
    expect(mockWithdraw).not.toHaveBeenCalled()
    expect(mockShowAlert).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        'vault_err_key_cannot_cover:{"nickname":"Safe · …0002","reachable":"200,000 sats","total":"500,000 sats","otherNames":"Desk · …0001"}'
      )
    ).toBeTruthy()
    // The screen is usable again afterwards.
    expect(screen.getByText('vault_withdraw_cta')).toBeTruthy()
  })

  test('a double tap during the preview withdraws only once', async () => {
    mockBalance = 500_000
    let resolvePreview: (v: unknown) => void = () => {}
    mockPreview.mockImplementationOnce(() => new Promise(resolve => { resolvePreview = resolve }))
    const screen = await renderTransfer('withdraw')
    fireEvent.changeText(screen.getByTestId('amount'), '50000')
    await act(async () => {
      fireEvent.press(screen.getByText('vault_withdraw_cta'))
      fireEvent.press(screen.getByText('vault_withdraw_cta'))
    })
    await act(async () => {
      resolvePreview(previewOf(500_000))
      await new Promise(r => setImmediate(r))
    })
    await settle()
    expect(mockPreview).toHaveBeenCalledTimes(1)
    expect(mockWithdraw).toHaveBeenCalledTimes(1)
  })

  test('unreachable outputs produce an alert after the transfer, naming the keys', async () => {
    mockBalance = 500_000
    mockWithdraw.mockResolvedValueOnce({
      txid: 'tx',
      cappedInputs: 0,
      unreachable: { count: 2, satoshis: 120_000, keys: [{ serial: '12340001', pubkey: PUB('a') }] }
    })
    mockShowAlert.mockResolvedValueOnce('ok')
    // total 500,000 - moved 50,000 (withdrawAll is false; the typed amount is
    // well under the preview's selectable total, so no remainder-confirm) —
    // matches on the first read, so the balance-settle loop returns at once.
    mockGetVaultBalance.mockResolvedValueOnce(450_000)
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '50000', 'vault_withdraw_cta')
    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'vault_unreachable_title',
        message:
          'vault_unreachable_body:{"moved":"50,000 sats","count":2,"amount":"120,000 sats","names":"Desk · …0001"}'
      })
    )
    expect(mockShowToast).not.toHaveBeenCalledWith('vault_withdraw_done', expect.anything())
    expect(mockRouter.back).toHaveBeenCalled()
  })

  test('a capped withdrawal alerts with the remaining count', async () => {
    mockBalance = 5_000_000
    mockWithdraw.mockResolvedValueOnce({ ...OK_RESULT, cappedInputs: 7 })
    mockShowAlert.mockResolvedValueOnce('ok')
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '4000000', 'vault_withdraw_cta')
    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'vault_withdraw_done', message: 'vault_withdraw_partial:{"count":7}' })
    )
  })

  test('serial-mismatch names the tapped and the chosen key when details carries both serials', async () => {
    mockBalance = 500_000
    const err = new VaultError('serial-mismatch') as VaultError & { details?: unknown }
    err.details = { tapped: '12340001', chosen: '12340002' }
    mockWithdraw.mockRejectedValueOnce(err)
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '50000', 'vault_withdraw_cta')
    expect(
      screen.getByText('vault_err_serial_mismatch_chosen:{"tappedName":"Desk · …0001","chosenName":"Safe · …0002"}')
    ).toBeTruthy()
  })

  test('serial-mismatch for an unknown card lists the vault keys', async () => {
    mockBalance = 500_000
    const err = new VaultError('serial-mismatch') as VaultError & { details?: unknown }
    err.details = { tapped: '99999999', chosen: '12340002' }
    mockWithdraw.mockRejectedValueOnce(err)
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '50000', 'vault_withdraw_cta')
    expect(screen.getByText('vault_err_serial_mismatch:{"names":"Desk · …0001, Safe · …0002"}')).toBeTruthy()
  })

  test('key-cannot-cover uses reachable/total from the error details when present', async () => {
    mockBalance = 500_000
    const err = new VaultError('key-cannot-cover') as VaultError & { details?: unknown }
    err.details = { reachable: 200_000, total: 500_000 }
    mockWithdraw.mockRejectedValueOnce(err)
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '300000', 'vault_withdraw_cta')
    expect(
      screen.getByText(
        'vault_err_key_cannot_cover:{"nickname":"Safe · …0002","reachable":"200,000 sats","total":"500,000 sats","otherNames":"Desk · …0001"}'
      )
    ).toBeTruthy()
  })

  test('key-cannot-cover without details degrades to amount-exceeds-balance', async () => {
    mockBalance = 500_000
    mockWithdraw.mockRejectedValueOnce(new VaultError('key-cannot-cover'))
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '300000', 'vault_withdraw_cta')
    expect(screen.getByText('vault_err_amount_exceeds_balance')).toBeTruthy()
  })
})
