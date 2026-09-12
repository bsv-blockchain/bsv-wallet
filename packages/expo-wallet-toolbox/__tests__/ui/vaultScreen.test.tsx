import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'

const mockT = (k: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() }
const mockShowAlert = jest.fn()
const mockShowToast = jest.fn()
const mockGetMeta = jest.fn()
const mockRenameKey = jest.fn()
const mockRelock = jest.fn()
const mockRecover = jest.fn()
const mockAdopt = jest.fn()
const mockBeginRemoval = jest.fn()
const mockFinalizeRemoval = jest.fn()
const mockDisable = jest.fn()
const mockDisableWhenSafe = jest.fn()
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
    captureScopeToken: () => ({ identityKey: 'scope', chain: 'test', generation: 1 }),
    getMeta: (...a: unknown[]) => mockGetMeta(...a),
    renameKey: (...a: unknown[]) => mockRenameKey(...a)
  },
  getVaultDriver: () => ({ isSupported: () => mockSupported }),
  isVaultEnabled: () => mockVaultEnabled,
  disableVault: (...a: unknown[]) => mockDisable(...a),
  disableVaultWhenSafe: (...a: unknown[]) => mockDisableWhenSafe(...a),
  relockVault: (...a: unknown[]) => mockRelock(...a),
  recoverVaultMetaFromOutputs: (...a: unknown[]) => mockRecover(...a),
  adoptVaultKey: (...a: unknown[]) => mockAdopt(...a),
  beginVaultKeyRemoval: (...a: unknown[]) => mockBeginRemoval(...a),
  finalizeVaultKeyRemoval: (...a: unknown[]) => mockFinalizeRemoval(...a),
  estimateRelockFee: () => 2900,
  R1C_LOCK_LEN: () => 45204,
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
  const { Pressable, Text } = require('react-native')
  return {
    EnrollWizard: ({ mode, onDone, onCancel }: any) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Text, null, `WIZARD:${mode}`),
        React.createElement(Pressable, { onPress: onDone }, React.createElement(Text, null, 'WIZARD_DONE')),
        React.createElement(Pressable, { onPress: onCancel }, React.createElement(Text, null, 'WIZARD_CANCEL'))
      )
  }
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
const META2 = {
  v: 6,
  vaultId: '11'.repeat(32),
  revision: 1,
  createdAt: 1,
  lastUsedSerial: '12340002',
  keys: [key(1, 'Desk', 'a'), key(2, 'Safe', 'b')]
}
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

function actionAccessibilityState(screen: Awaited<ReturnType<typeof renderVault>>, label: string) {
  let node: any = screen.getByText(label)
  while (node && node.props.accessibilityState === undefined) node = node.parent
  return node?.props.accessibilityState
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVaultEnabled = true
  mockSupported = true
  mockBalance = 0
  mockCoverage = CLEAN
  mockGetMeta.mockReset().mockResolvedValue(META2)
  mockRenameKey.mockReset().mockResolvedValue(META2)
  mockRelock.mockReset()
  mockRecover.mockReset().mockResolvedValue(null)
  mockAdopt.mockReset().mockResolvedValue(undefined)
  mockBeginRemoval.mockReset().mockResolvedValue({ complete: true, meta: META2 })
  mockFinalizeRemoval.mockReset().mockResolvedValue(false)
  mockDisable.mockReset().mockResolvedValue(undefined)
  mockDisableWhenSafe.mockReset().mockResolvedValue(true)
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
  test('lists every key as nickname · full serial (grouped in threes) with the footnote and the key-count header', async () => {
    const screen = await renderVault()
    expect(screen.getByText('vault_key_section:{"count":2}')).toBeTruthy()
    expect(screen.getByText('Desk · 12 340 001')).toBeTruthy()
    expect(screen.getByText('Safe · 12 340 002')).toBeTruthy()
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

  test('cancelling the add-key wizard reloads the key list and offers no re-lock', async () => {
    mockBalance = 300_000
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_add_key_row')))
    expect(screen.getByText('WIZARD:add-key')).toBeTruthy()
    // The wizard persisted a third key, then closed via onCancel.
    mockGetMeta.mockResolvedValue(META3)
    mockRefreshCoverage.mockClear()
    await act(async () => fireEvent.press(screen.getByText('WIZARD_CANCEL')))
    await settle()
    expect(screen.queryByText('WIZARD:add-key')).toBeNull()
    expect(screen.getByText('vault_key_section:{"count":3}')).toBeTruthy()
    expect(screen.getByText('Car · 12 340 003')).toBeTruthy()
    expect(mockRefreshCoverage).toHaveBeenCalled()
    expect(screen.queryByText('vault_relock_choose')).toBeNull()
  })

  test('finishing the add-key wizard with a funded vault offers a re-lock that excludes the new key', async () => {
    mockBalance = 300_000
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_add_key_row')))
    mockGetMeta.mockResolvedValue(META3)
    await act(async () => fireEvent.press(screen.getByText('WIZARD_DONE')))
    await settle()
    expect(screen.getByText('vault_key_section:{"count":3}')).toBeTruthy()
    expect(screen.getByText('vault_relock_choose')).toBeTruthy()
    expect(screen.getByText('vault_relock_reason:{"names":"Desk · …0001, Safe · …0002"}')).toBeTruthy()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
  })

  test('Add key is inert while the flag is off, but the enrolled view stays', async () => {
    mockVaultEnabled = false
    const screen = await renderVault()
    expect(screen.getByText('vault_withdraw_cta')).toBeTruthy()
    expect(screen.getByText('vault_not_released_body')).toBeTruthy()
    expect(screen.queryByText('vault_add_key_row')).toBeNull()
  })

  test('removing a key uses the two-phase service; an empty vault needs no re-lock', async () => {
    mockGetMeta.mockResolvedValue(META3)
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValueOnce('remove')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Desk · 12 340 001')))
    await settle()
    expect(mockShowAlert).toHaveBeenCalledTimes(2)
    expect(mockShowAlert.mock.calls[0][0].buttons.map((b: any) => b.text)).toEqual([
      'vault_key_action_rename',
      'vault_key_action_remove',
      'vault_cancel'
    ])
    const confirm = mockShowAlert.mock.calls[1][0]
    expect(confirm.title).toBe('vault_remove_title:{"nickname":"Desk"}')
    expect(confirm.message).toBe('vault_remove_body:{"nickname":"Desk","fee":"2,900"}')
    expect(confirm.buttons.map((b: any) => b.text)).toEqual(['vault_remove_only', 'vault_cancel'])
    expect(mockBeginRemoval).toHaveBeenCalledWith(mockWallet.managers.permissionsManager, 'admin.test', '12340001')
    expect(mockShowToast).toHaveBeenCalledWith('vault_key_removed_toast', { type: 'info' })
    expect(screen.queryByText('vault_relock_choose')).toBeNull()
  })

  test('flag off: the confirmation offers Remove only / Cancel — re-locking creates a vault output, which the flag gates', async () => {
    // Same gating as the Re-lock actions (openGenericRelock): with the flag
    // off the re-lock sheet could only refuse with not-released. The flag-on
    // case above pins the three-button form.
    mockVaultEnabled = false
    mockGetMeta.mockResolvedValue(META3)
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValueOnce('remove')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Desk · 12 340 001')))
    await settle()
    expect(mockShowAlert).toHaveBeenCalledTimes(2)
    const confirm = mockShowAlert.mock.calls[1][0]
    expect(confirm.title).toBe('vault_remove_title:{"nickname":"Desk"}')
    expect(confirm.buttons.map((b: any) => b.text)).toEqual(['vault_remove_only', 'vault_cancel'])
    expect(mockBeginRemoval).toHaveBeenCalledWith(mockWallet.managers.permissionsManager, 'admin.test', '12340001')
    expect(screen.queryByText('vault_relock_choose')).toBeNull()
  })

  test('removing a key from a funded vault removes, then opens the re-lock sheet on its own — no choice offered', async () => {
    mockGetMeta.mockResolvedValue(META3)
    mockBeginRemoval.mockResolvedValue({ complete: false, meta: META2 })
    mockBalance = 300_000
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValueOnce('remove')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Car · 12 340 003')))
    await settle()
    expect(mockBeginRemoval).toHaveBeenCalledWith(mockWallet.managers.permissionsManager, 'admin.test', '12340003')
    expect(screen.getByText('vault_relock_choose')).toBeTruthy()
  })

  test('removal is refused at two keys', async () => {
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValueOnce('ok')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Desk · 12 340 001')))
    await settle()
    expect(mockShowAlert.mock.calls[1][0].message).toBe('vault_err_last_keys')
    expect(mockBeginRemoval).not.toHaveBeenCalled()
  })

  test('removal failure from the authoritative two-phase service is shown and never opens re-lock', async () => {
    mockGetMeta.mockResolvedValue(META3)
    const { VaultError } = jest.requireActual('../../core/services/vault/types')
    mockBeginRemoval.mockRejectedValueOnce(new VaultError('relock-required'))
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValueOnce('remove').mockResolvedValueOnce('ok')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Desk · 12 340 001')))
    await settle()
    expect(mockShowAlert).toHaveBeenCalledTimes(3)
    expect(mockShowAlert.mock.calls[2][0].message).toBe('vault_err_relock_required')
    expect(screen.queryByText('vault_relock_choose')).toBeNull()
  })

  test('rename saves through vaultStore.renameKey', async () => {
    mockShowAlert.mockResolvedValueOnce('rename')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Safe · 12 340 002')))
    await settle()
    const field = screen.getByLabelText('vault_rename_title:{"nickname":"Safe"}')
    fireEvent.changeText(field, 'Office safe')
    await act(async () => fireEvent.press(screen.getByText('vault_rename_save')))
    await settle()
    expect(mockRenameKey).toHaveBeenCalledWith('12340002', 'Office safe')
  })

  test('re-lock defaults to the last-used key, loops while capped, then reports the unreachable keys', async () => {
    mockBalance = 300_000
    // No standalone "re-lock now" row (spec revision): reach the same sheet
    // through a coverage badge, same as a real missing-key situation would.
    mockCoverage = { outputs: 4, stale: 1, missingKeys: [PUB('a')], removedKeyOutputs: 0 }
    mockRelock
      .mockResolvedValueOnce({ txid: 'a', cappedInputs: 2, unreachable: NO_UNREACHABLE })
      .mockResolvedValueOnce({
        txid: 'b',
        cappedInputs: 0,
        unreachable: { count: 1, satoshis: 50_000, keys: [{ serial: '12340001', pubkey: PUB('a') }] }
      })
    mockShowAlert.mockResolvedValueOnce('ok')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_badge_missing:{"count":1,"nickname":"Desk"}')))
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
    mockCoverage = { outputs: 4, stale: 1, missingKeys: [PUB('a')], removedKeyOutputs: 0 }
    mockRelock.mockResolvedValueOnce({ txid: 'a', cappedInputs: 0, unreachable: NO_UNREACHABLE })
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_badge_missing:{"count":1,"nickname":"Desk"}')))
    await act(async () => fireEvent.press(screen.getByText('vault_relock_now')))
    await settle()
    expect(mockShowToast).toHaveBeenCalledWith('vault_relock_done', { type: 'success' })
    expect(screen.queryByText('vault_relock_choose')).toBeNull()
  })

  test('a re-lock that makes no progress stops after the second authenticated pass', async () => {
    mockBalance = 300_000
    mockCoverage = { outputs: 4, stale: 1, missingKeys: [PUB('a')], removedKeyOutputs: 0 }
    mockRelock.mockResolvedValue({ txid: 'a', cappedInputs: 1, unreachable: NO_UNREACHABLE })
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_badge_missing:{"count":1,"nickname":"Desk"}')))
    await act(async () => fireEvent.press(screen.getByText('vault_relock_now')))
    await settle()
    expect(mockRelock).toHaveBeenCalledTimes(2)
    expect(mockShowToast).toHaveBeenCalledWith('vault_relock_capped:{"count":1}', { type: 'info' })
    expect(mockShowToast).not.toHaveBeenCalledWith('vault_relock_done', expect.anything())
    expect(mockShowAlert).not.toHaveBeenCalled()
    expect(screen.getByText('vault_relock_choose')).toBeTruthy()
    expect(screen.getByText('vault_err_template_invalid')).toBeTruthy()
  })

  test('a re-lock error stays in the sheet with its copy', async () => {
    mockBalance = 50_000
    mockCoverage = { outputs: 4, stale: 1, missingKeys: [PUB('a')], removedKeyOutputs: 0 }
    const { VaultError } = jest.requireActual('../../core/services/vault/types')
    mockRelock.mockRejectedValueOnce(new VaultError('too-small-to-relock'))
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_badge_missing:{"count":1,"nickname":"Desk"}')))
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
    expect(mockDisableWhenSafe).toHaveBeenCalledWith(
      mockWallet.managers.permissionsManager,
      'admin.test',
      expect.any(Function)
    )
    const clear = mockDisableWhenSafe.mock.calls[0][2]
    const token = { identityKey: 'scope', chain: 'test', generation: 1 }
    await clear(token)
    expect(mockDisable).toHaveBeenCalledWith(token)
  })

  test('a recovered key requires a live adoption challenge and keeps the opening scope token', async () => {
    const recovered = { ...META2, recovery: { required: true, adoptedSerials: [] } }
    const adopted = { ...META2, recovery: { required: true, adoptedSerials: ['12340001'] } }
    mockGetMeta.mockResolvedValueOnce(recovered).mockResolvedValueOnce(adopted)
    const screen = await renderVault()
    expect(screen.getAllByText('vault_err_key_not_adopted').length).toBeGreaterThan(0)

    await act(async () => fireEvent.press(screen.getByText('Desk · 12 340 001')))
    fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '654321')
    await act(async () => fireEvent.press(screen.getByText('vault_continue')))
    await settle()

    expect(mockAdopt).toHaveBeenCalledWith(expect.objectContaining({
      record: META2.keys[0],
      scopeToken: { identityKey: 'scope', chain: 'test', generation: 1 }
    }))
    await expect(mockAdopt.mock.calls[0][0].getPin()).resolves.toBe('654321')
    expect(mockShowToast).toHaveBeenCalledWith('vault_recovery_verified', { type: 'success' })
  })

  test('recovery adoption gates deposits at two keys but permits withdrawal with one proven key', async () => {
    mockGetMeta.mockResolvedValue({ ...META2, recovery: { required: true, adoptedSerials: ['12340001'] } })
    const screen = await renderVault()
    expect(actionAccessibilityState(screen, 'vault_deposit_cta')).toEqual({ disabled: true })
    expect(actionAccessibilityState(screen, 'vault_withdraw_cta')).toEqual({ disabled: false })

    screen.unmount()
    mockGetMeta.mockResolvedValue({ ...META2, recovery: { required: true, adoptedSerials: ['12340001', '12340002'] } })
    const redundant = await renderVault()
    expect(actionAccessibilityState(redundant, 'vault_deposit_cta')).toEqual({ disabled: false })
    expect(actionAccessibilityState(redundant, 'vault_withdraw_cta')).toEqual({ disabled: false })
  })

  test('pending key removal disables ordinary deposits and withdrawals and stays visible', async () => {
    const pendingMeta = {
      ...META2,
      keys: [META2.keys[0]],
      pendingRemoval: {
        key: META2.keys[1],
        keyIndex: 1,
        startedAt: 2,
        revision: 2,
        state: 'prepared' as const
      }
    }
    mockGetMeta.mockResolvedValue(pendingMeta)
    const screen = await renderVault()
    expect(actionAccessibilityState(screen, 'vault_deposit_cta')).toEqual({ disabled: true })
    expect(actionAccessibilityState(screen, 'vault_withdraw_cta')).toEqual({ disabled: true })
    expect(screen.getByText('Safe · 12 340 002')).toBeTruthy()
    expect(screen.getByText('tx_still_pending')).toBeTruthy()
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

})
