import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'

const mockT = (k: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() }
const mockShowAlert = jest.fn()
const mockShowToast = jest.fn()
const mockGetMeta = jest.fn()
const mockRemoveKey = jest.fn()
const mockRenameKey = jest.fn()
const mockRelock = jest.fn()
const mockOrphanedIfRemoved = jest.fn()
const mockDisable = jest.fn()
const mockReclaim = jest.fn()
const mockRefreshCoverage = jest.fn()
const mockExportData = jest.fn()
let mockVaultEnabled = true
let mockSupported = true
let mockBalance: number | null = 0
let mockCoverage: unknown = null
let mockWallet: any

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} }),
  i18n: { t: (k: string, o?: Record<string, unknown>) => mockT(k, o) },
  useWallet: () => mockWallet,
  useLocalStorage: () => ({ hasStoredIdentity: async () => true, createMnemonic: jest.fn(), secretsReady: true }),
  VaultError: jest.requireActual('../../core/services/vault/types').VaultError,
  vaultStore: {
    getMeta: (...a: unknown[]) => mockGetMeta(...a),
    removeKey: (...a: unknown[]) => mockRemoveKey(...a),
    renameKey: (...a: unknown[]) => mockRenameKey(...a)
  },
  getVaultDriver: () => ({ isSupported: () => mockSupported }),
  isVaultEnabled: () => mockVaultEnabled,
  disableVault: (...a: unknown[]) => mockDisable(...a),
  relockVault: (...a: unknown[]) => mockRelock(...a),
  orphanedIfRemoved: (...a: unknown[]) => mockOrphanedIfRemoved(...a),
  reclaimStagingOutputs: (...a: unknown[]) => mockReclaim(...a),
  estimateRelockFee: () => 2900,
  R1C_LOCK_LEN: () => 27881,
  VAULT_MIN_KEYS: 2,
  VAULT_MAX_KEYS: 5,
  getOnline: async () => true,
  generateMnemonicWallet: jest.fn(),
  backupAttestation: { markPending: jest.fn() },
  sounds: { vaultOpen: jest.fn(), vaultClose: jest.fn() },
  haptics: { tap: jest.fn(), confirm: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() }
}))
jest.mock('expo-router', () => ({ router: mockRouter, useLocalSearchParams: () => ({}), useFocusEffect: () => {} }))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return ({ children, onPress, ...props }: any) => React.createElement(Pressable, { onPress, ...props }, children)
})
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: (...a: unknown[]) => mockShowAlert(...a) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: (...a: unknown[]) => mockShowToast(...a) }))
jest.mock('../../ui/components/ui/ListRow', () => {
  const React = require('react')
  const { Pressable, Text } = require('react-native')
  return {
    ListRow: ({ label, subtitle, value, onPress }: any) =>
      React.createElement(
        Pressable,
        { onPress, accessibilityState: { disabled: !onPress } },
        React.createElement(Text, null, label),
        subtitle ? React.createElement(Text, null, subtitle) : null,
        value ? React.createElement(Text, null, value) : null
      )
  }
})
jest.mock('../../ui/components/ui/GroupedList', () => {
  const React = require('react')
  const { Text } = require('react-native')
  return {
    GroupedSection: ({ header, footer, children }: any) =>
      React.createElement(
        React.Fragment,
        null,
        header ? React.createElement(Text, null, header) : null,
        children,
        footer ? React.createElement(Text, null, footer) : null
      )
  }
})
jest.mock('../../ui/components/ui/Sheet', () => {
  const React = require('react')
  return { __esModule: true, default: ({ visible, children }: any) => (visible ? React.createElement(React.Fragment, null, children) : null) }
})
jest.mock('../../ui/components/wallet/AmountDisplay', () => {
  const React = require('react')
  const { Text } = require('react-native')
  return { __esModule: true, default: ({ children }: any) => React.createElement(Text, null, `${children} sats`) }
})
jest.mock('../../ui/components/wallet/BiometricAdvisoryModal', () => ({ BiometricAdvisoryModal: () => null }))
jest.mock('../../ui/components/vault/VaultBackdrop', () => ({ VaultBackdrop: () => null }))
jest.mock('../../ui/components/vault/EnrollWizard', () => {
  const React = require('react')
  const { Text } = require('react-native')
  return { EnrollWizard: ({ mode }: any) => React.createElement(Text, null, `WIZARD:${mode}`) }
})
jest.mock('../../ui/hooks/useVaultBalance', () => ({
  useVaultBalance: () => ({ balance: mockBalance, loading: false, refresh: jest.fn() })
}))
jest.mock('../../ui/hooks/useVaultCoverage', () => ({
  useVaultCoverage: () => ({ coverage: mockCoverage, refresh: mockRefreshCoverage })
}))
jest.mock('../../ui/hooks/useExportWalletData', () => ({
  useExportWalletData: () => ({ exportData: mockExportData, exporting: false })
}))

import { VaultScreen } from '../../ui/screens/VaultScreen'

const PUB = (c: string) => '02' + c.repeat(64)
const key = (n: number, nickname: string, c: string) => ({
  serial: `1234000${n}`,
  slot: 0x82,
  pubkey: PUB(c),
  nickname,
  enrolledAt: 1_700_000_000_000 + n
})
const META2 = { v: 5, createdAt: 1, lastUsedSerial: '12340002', keys: [key(1, 'Desk', 'a'), key(2, 'Safe', 'b')] }
const META3 = { ...META2, keys: [...META2.keys, key(3, 'Car', 'c')] }
const META5 = { ...META2, keys: [...META3.keys, key(4, 'Bank', 'd'), key(5, 'Parents', 'e')] }
const CLEAN = { outputs: 4, stale: 0, missingKeys: [], removedKeyOutputs: 0 }
const NO_UNREACHABLE = { count: 0, satoshis: 0, keys: [] }

const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
  })
}

async function renderVault() {
  const screen = render(<VaultScreen />)
  await settle()
  return screen
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVaultEnabled = true
  mockSupported = true
  mockBalance = 0
  mockCoverage = CLEAN
  mockGetMeta.mockReset().mockResolvedValue(META2)
  mockRemoveKey.mockReset().mockResolvedValue(META2)
  mockRenameKey.mockReset().mockResolvedValue(META2)
  mockRelock.mockReset()
  mockOrphanedIfRemoved.mockReset().mockResolvedValue(0)
  mockDisable.mockReset().mockResolvedValue(undefined)
  mockReclaim.mockReset().mockResolvedValue({ reclaimed: 0, satoshis: 0 })
  mockShowAlert.mockReset()
  mockWallet = {
    managers: { permissionsManager: { listOutputs: jest.fn() } },
    adminOriginator: 'admin.test',
    storage: null,
    walletBuilding: false,
    buildWalletFromMnemonic: jest.fn()
  }
})

describe('not enrolled', () => {
  test('flag off: hero with the not-released notice and an inert CTA', async () => {
    mockVaultEnabled = false
    mockGetMeta.mockResolvedValue(null)
    const screen = await renderVault()
    expect(screen.getByText('vault_hero_title')).toBeTruthy()
    expect(screen.getByText('vault_not_released_body')).toBeTruthy()
    await act(async () => fireEvent.press(screen.getByText('vault_enroll_begin')))
    expect(screen.queryByText('WIZARD:enroll')).toBeNull()
  })

  test('driver unsupported: hero with the needs-a-YubiKey notice and an inert CTA', async () => {
    mockSupported = false
    mockGetMeta.mockResolvedValue(null)
    const screen = await renderVault()
    expect(screen.getByText('vault_unsupported_title')).toBeTruthy()
    await act(async () => fireEvent.press(screen.getByText('vault_enroll_begin')))
    expect(screen.queryByText('WIZARD:enroll')).toBeNull()
  })

  test('flag on, supported: the CTA opens the wizard in enroll mode', async () => {
    mockGetMeta.mockResolvedValue(null)
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_enroll_begin')))
    expect(screen.getByText('WIZARD:enroll')).toBeTruthy()
  })
})

describe('enrolled', () => {
  test('lists every key as nickname · …tail4 with the footnote and the key-count header', async () => {
    const screen = await renderVault()
    expect(screen.getByText('vault_key_section:{"count":2}')).toBeTruthy()
    expect(screen.getByText('Desk · …0001')).toBeTruthy()
    expect(screen.getByText('Safe · …0002')).toBeTruthy()
    expect(screen.getByText('vault_footnote')).toBeTruthy()
    expect(screen.getByText('vault_export_explainer')).toBeTruthy()
    expect(screen.getByText('export_wallet_data')).toBeTruthy()
  })

  test('shows the not-yet-open badge when outputs are stale and it opens re-lock', async () => {
    mockCoverage = { outputs: 4, stale: 3, missingKeys: [PUB('b')], removedKeyOutputs: 0 }
    mockBalance = 300_000
    const screen = await renderVault()
    const badge = screen.getByText('vault_badge_missing:{"count":3,"nickname":"Safe"}')
    expect(screen.queryByText(/vault_badge_removed/)).toBeNull()
    fireEvent.press(badge)
    expect(screen.getByText('vault_relock_choose')).toBeTruthy()
    expect(screen.getByText('vault_relock_reason_generic')).toBeTruthy()
  })

  test('shows the removed-key badge', async () => {
    mockCoverage = { outputs: 4, stale: 2, missingKeys: [], removedKeyOutputs: 2 }
    const screen = await renderVault()
    expect(screen.getByText('vault_badge_removed:{"count":2}')).toBeTruthy()
  })

  test('no badges when every output carries the current key set', async () => {
    const screen = await renderVault()
    expect(screen.queryByText(/vault_badge_/)).toBeNull()
  })

  test('Add key is shown below five keys and opens the wizard in add-key mode', async () => {
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_add_key_row')))
    expect(screen.getByText('WIZARD:add-key')).toBeTruthy()
  })

  test('Add key is hidden at five keys', async () => {
    mockGetMeta.mockResolvedValue(META5)
    const screen = await renderVault()
    expect(screen.getByText('vault_key_section:{"count":5}')).toBeTruthy()
    expect(screen.queryByText('vault_add_key_row')).toBeNull()
  })

  test('Add key is inert while the flag is off, but the enrolled view stays', async () => {
    mockVaultEnabled = false
    const screen = await renderVault()
    expect(screen.getByText('vault_withdraw_cta')).toBeTruthy()
    expect(screen.getByText('vault_not_released_body')).toBeTruthy()
    expect(screen.queryByText('vault_add_key_row')).toBeNull()
  })

  test('removing a key shows the three-button confirmation and removes on Remove only', async () => {
    mockGetMeta.mockResolvedValue(META3)
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValueOnce('remove')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Desk · …0001')))
    await settle()
    expect(mockOrphanedIfRemoved).toHaveBeenCalledWith(mockWallet.managers.permissionsManager, 'admin.test', PUB('a'))
    expect(mockShowAlert).toHaveBeenCalledTimes(2)
    expect(mockShowAlert.mock.calls[0][0].buttons.map((b: any) => b.text)).toEqual([
      'vault_key_action_rename',
      'vault_key_action_remove',
      'vault_cancel'
    ])
    const confirm = mockShowAlert.mock.calls[1][0]
    expect(confirm.title).toBe('vault_remove_title:{"nickname":"Desk"}')
    expect(confirm.message).toBe('vault_remove_body:{"nickname":"Desk","fee":"2,900"}')
    expect(confirm.buttons.map((b: any) => b.text)).toEqual(['vault_remove_and_relock', 'vault_remove_only', 'vault_cancel'])
    expect(mockRemoveKey).toHaveBeenCalledWith('12340001')
    expect(mockShowToast).toHaveBeenCalledWith('vault_key_removed_toast', { type: 'info' })
    expect(screen.queryByText('vault_relock_choose')).toBeNull()
  })

  test('Remove and re-lock now removes, then opens the re-lock sheet', async () => {
    mockGetMeta.mockResolvedValue(META3)
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValueOnce('relock')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Car · …0003')))
    await settle()
    expect(mockRemoveKey).toHaveBeenCalledWith('12340003')
    expect(screen.getByText('vault_relock_choose')).toBeTruthy()
  })

  test('removal is refused at two keys', async () => {
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValueOnce('ok')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Desk · …0001')))
    await settle()
    expect(mockShowAlert.mock.calls[1][0].message).toBe('vault_err_last_keys')
    expect(mockRemoveKey).not.toHaveBeenCalled()
  })

  test('removal is refused with relock-required when orphanedIfRemoved reports an orphan', async () => {
    mockGetMeta.mockResolvedValue(META3)
    mockOrphanedIfRemoved.mockResolvedValueOnce(1)
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValueOnce('ok')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Desk · …0001')))
    await settle()
    expect(mockOrphanedIfRemoved).toHaveBeenCalledWith(mockWallet.managers.permissionsManager, 'admin.test', PUB('a'))
    expect(mockShowAlert.mock.calls[1][0].message).toBe('vault_err_relock_required')
    expect(mockRemoveKey).not.toHaveBeenCalled()
  })

  test('rename saves through vaultStore.renameKey', async () => {
    mockShowAlert.mockResolvedValueOnce('rename')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Safe · …0002')))
    await settle()
    const field = screen.getByLabelText('vault_rename_title:{"nickname":"Safe"}')
    fireEvent.changeText(field, 'Office safe')
    await act(async () => fireEvent.press(screen.getByText('vault_rename_save')))
    await settle()
    expect(mockRenameKey).toHaveBeenCalledWith('12340002', 'Office safe')
  })

  test('re-lock defaults to the last-used key, loops while capped, then reports the unreachable keys', async () => {
    mockBalance = 300_000
    mockRelock
      .mockResolvedValueOnce({ txid: 'a', cappedInputs: 2, unreachable: NO_UNREACHABLE })
      .mockResolvedValueOnce({
        txid: 'b',
        cappedInputs: 0,
        unreachable: { count: 1, satoshis: 50_000, keys: [{ serial: '12340001', pubkey: PUB('a') }] }
      })
    mockShowAlert.mockResolvedValueOnce('ok')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_relock_row')))
    const radios = screen.getAllByRole('radio')
    expect(radios[1].props.accessibilityState).toEqual({ selected: true }) // Safe = lastUsedSerial

    await act(async () => fireEvent.press(screen.getByText('vault_relock_now')))
    await settle()
    expect(mockRelock).toHaveBeenCalledTimes(2)
    expect(mockRelock.mock.calls[0].slice(1, 4)).toEqual(['admin.test', 'vault_relock_reason_generic', '12340002'])
    expect(mockShowToast).toHaveBeenCalledWith('vault_relock_capped:{"count":2}', { type: 'info' })
    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'vault_relock_unreachable:{"count":1,"names":"Desk · …0001"}'
      })
    )
    expect(mockRefreshCoverage).toHaveBeenCalled()
  })

  test('a clean re-lock toasts done', async () => {
    mockBalance = 300_000
    mockRelock.mockResolvedValueOnce({ txid: 'a', cappedInputs: 0, unreachable: NO_UNREACHABLE })
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_relock_row')))
    await act(async () => fireEvent.press(screen.getByText('vault_relock_now')))
    await settle()
    expect(mockShowToast).toHaveBeenCalledWith('vault_relock_done', { type: 'success' })
    expect(screen.queryByText('vault_relock_choose')).toBeNull()
  })

  test('a re-lock error stays in the sheet with its copy', async () => {
    mockBalance = 50_000
    const { VaultError } = jest.requireActual('../../core/services/vault/types')
    mockRelock.mockRejectedValueOnce(new VaultError('too-small-to-relock'))
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_relock_row')))
    await act(async () => fireEvent.press(screen.getByText('vault_relock_now')))
    await settle()
    expect(screen.getByText('vault_err_too_small_to_relock')).toBeTruthy()
    expect(screen.getByText('vault_relock_choose')).toBeTruthy()
  })

  test('disable is refused while the vault holds funds and clears meta when empty', async () => {
    mockBalance = 10
    mockShowAlert.mockResolvedValueOnce('ok')
    let screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_disable_row')))
    await settle()
    expect(mockShowAlert).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'vault_disable_blocked_title' }))
    expect(mockDisable).not.toHaveBeenCalled()

    screen.unmount()
    mockBalance = 0
    mockShowAlert.mockResolvedValueOnce('confirm')
    screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_disable_row')))
    await settle()
    expect(mockDisable).toHaveBeenCalledTimes(1)
  })

  test('the export row runs the shared export action', async () => {
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('export_wallet_data')))
    expect(mockExportData).toHaveBeenCalledTimes(1)
  })

  test('deposit pushes the transfer route when a wallet exists; withdraw always does', async () => {
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_deposit_cta')))
    expect(mockRouter.push).toHaveBeenCalledWith('/vault-transfer?direction=deposit')
    await act(async () => fireEvent.press(screen.getByText('vault_withdraw_cta')))
    expect(mockRouter.push).toHaveBeenCalledWith('/vault-transfer?direction=withdraw')
  })

  test('the legacy staging reclaim still runs once for an enrolled vault', async () => {
    await renderVault()
    expect(mockReclaim).toHaveBeenCalledTimes(1)
  })
})
