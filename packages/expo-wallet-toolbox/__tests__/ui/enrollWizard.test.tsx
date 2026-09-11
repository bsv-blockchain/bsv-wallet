import React from 'react'
import { BackHandler } from 'react-native'
import { act, fireEvent, render } from '@testing-library/react-native'

const mockT = (k: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() }
const mockEnrollKey = jest.fn()
const mockFinalize = jest.fn()
const mockAddVaultKey = jest.fn()
const mockShowAlert = jest.fn()
const mockShowToast = jest.fn()
let mockMeta: unknown = null
let mockBackupOn = true

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} }),
  i18n: { t: (k: string, o?: Record<string, unknown>) => mockT(k, o) },
  VaultError: jest.requireActual('../../core/services/vault/types').VaultError,
  enrollKey: (...a: unknown[]) => mockEnrollKey(...a),
  finalizeEnrollment: (...a: unknown[]) => mockFinalize(...a),
  addVaultKey: (...a: unknown[]) => mockAddVaultKey(...a),
  vaultStore: { getMeta: async () => mockMeta },
  isBackupPushEnabled: async () => mockBackupOn,
  VAULT_MIN_KEYS: 2,
  VAULT_MAX_KEYS: 5,
  sounds: { vaultOpen: jest.fn(), vaultClose: jest.fn() },
  haptics: { tap: jest.fn(), confirm: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() }
}))
jest.mock('expo-router', () => ({ router: mockRouter, useLocalSearchParams: () => ({}), useFocusEffect: () => {} }))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return ({ children, onPress, ...props }: any) => React.createElement(Pressable, { onPress, ...props }, children)
})
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: (...a: unknown[]) => mockShowAlert(...a) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: (...a: unknown[]) => mockShowToast(...a) }))

import { EnrollWizard } from '../../ui/components/vault/EnrollWizard'
import { VaultError } from '../../core/services/vault/types'

const record = (serial: string, tail: string) => ({
  serial,
  slot: 0x82,
  pubkey: '02' + tail.repeat(32),
  nickname: '',
  enrolledAt: 1_700_000_000_000
})

/**
 * A key-already-enrolled rejection the way Plan 2's enrollKey throws it: code
 * plus a structured `details.serial` naming the duplicate (the DECISION is
 * that services attach `details`, not that the message encodes it).
 */
const dupError = (serial: string): VaultError & { details: { serial: string } } => {
  const e = new VaultError('key-already-enrolled', serial) as VaultError & { details: { serial: string } }
  e.details = { serial }
  return e
}

const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
  })
}

/**
 * Jest runs the iOS BackHandler, whose addEventListener is a no-op, so the
 * wizard's hardware-back handler is captured here and "pressed" the way RN
 * dispatches it on Android: newest subscription first.
 */
type BackPressHandler = () => boolean | null | undefined
const backHandlers: BackPressHandler[] = []
const pressBack = async () => {
  const handler = backHandlers[backHandlers.length - 1]
  expect(handler).toBeDefined()
  let handled: boolean | null | undefined
  await act(async () => {
    handled = handler()
  })
  await settle()
  return handled
}

beforeEach(() => {
  jest.clearAllMocks()
  mockMeta = null
  mockBackupOn = true
  mockEnrollKey.mockReset()
  mockFinalize.mockReset().mockResolvedValue(undefined)
  mockAddVaultKey.mockReset().mockResolvedValue({ v: 5, createdAt: 1, keys: [] })
  mockShowAlert.mockReset()
  backHandlers.length = 0
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    backHandlers.push(handler)
    return {
      remove: () => {
        const i = backHandlers.indexOf(handler)
        if (i !== -1) backHandlers.splice(i, 1)
      }
    }
  })
})

/** intro → key 1 pin sub-state. */
async function beginEnroll() {
  const onDone = jest.fn()
  const onCancel = jest.fn()
  const screen = render(<EnrollWizard mode="enroll" onDone={onDone} onCancel={onCancel} />)
  await settle()
  fireEvent.press(screen.getByText('vault_intro_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_intro_begin')))
  await settle()
  return { screen, onDone, onCancel }
}

/** From the pin sub-state: type a PIN, tap, name the key. Ends on `more` (enroll) or `done` (add-key). */
async function enrolOneKey(screen: ReturnType<typeof render>, name: string) {
  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '654321')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  fireEvent.changeText(screen.getByLabelText('vault_name_title'), name)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
}

test('Begin is inert until the acknowledgement is ticked', async () => {
  const screen = render(<EnrollWizard mode="enroll" onDone={jest.fn()} onCancel={jest.fn()} />)
  await settle()
  await act(async () => fireEvent.press(screen.getByText('vault_intro_begin')))
  expect(screen.queryByText('vault_key_step_title:{"k":1}')).toBeNull()
  fireEvent.press(screen.getByText('vault_intro_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_intro_begin')))
  await settle()
  expect(screen.getByText('vault_key_step_title:{"k":1}')).toBeTruthy()
})

test('Begin routes to settings instead of the key step while backup push is off', async () => {
  mockBackupOn = false
  mockShowAlert.mockResolvedValueOnce('settings')
  const screen = render(<EnrollWizard mode="enroll" onDone={jest.fn()} onCancel={jest.fn()} />)
  await settle()
  fireEvent.press(screen.getByText('vault_intro_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_intro_begin')))
  await settle()
  expect(mockShowAlert).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'vault_backup_off_title', message: 'vault_backup_off_body' })
  )
  expect(mockRouter.push).toHaveBeenCalledWith('/wallet-config')
  expect(screen.queryByText('vault_key_step_title:{"k":1}')).toBeNull()
})

test('Finish is disabled with one key and enabled with two; finalizeEnrollment gets both records', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a')).mockResolvedValueOnce(record('12340002', 'b'))
  const { screen, onDone } = await beginEnroll()

  await enrolOneKey(screen, 'Desk')
  expect(mockEnrollKey).toHaveBeenLastCalledWith(expect.objectContaining({ pendingSerials: [] }))
  expect(screen.getByText('vault_more_title')).toBeTruthy()
  expect(screen.getByText('vault_more_need_two')).toBeTruthy()
  await act(async () => fireEvent.press(screen.getByText('vault_more_finish')))
  expect(mockFinalize).not.toHaveBeenCalled()

  await act(async () => fireEvent.press(screen.getByText('vault_more_add')))
  expect(screen.getByText('vault_key_step_title:{"k":2}')).toBeTruthy()
  await enrolOneKey(screen, 'Safe')
  expect(mockEnrollKey).toHaveBeenLastCalledWith(expect.objectContaining({ pendingSerials: ['12340001'] }))
  expect(screen.queryByText('vault_more_need_two')).toBeNull()
  expect(screen.getByText('Desk · …0001')).toBeTruthy()
  expect(screen.getByText('Safe · …0002')).toBeTruthy()

  await act(async () => fireEvent.press(screen.getByText('vault_more_finish')))
  await settle()
  expect(mockFinalize).toHaveBeenCalledTimes(1)
  expect(mockFinalize.mock.calls[0][0]).toEqual([
    expect.objectContaining({ serial: '12340001', nickname: 'Desk' }),
    expect.objectContaining({ serial: '12340002', nickname: 'Safe' })
  ])
  expect(mockShowToast).toHaveBeenCalledWith('vault_enrolled_toast', { type: 'success' })
  expect(screen.getByText('vault_done_body:{"count":2}')).toBeTruthy()
  fireEvent.press(screen.getByText('vault_done_cta'))
  expect(onDone).toHaveBeenCalledTimes(1)
})

test('an empty name falls back to Key {{k}}', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a'))
  const { screen } = await beginEnroll()
  await enrolOneKey(screen, '')
  expect(screen.getByText('vault_name_default:{"k":1} · …0001')).toBeTruthy()
})

test('a duplicate of a pending key names it and offers Set it up again', async () => {
  mockEnrollKey
    .mockResolvedValueOnce(record('12340001', 'a'))
    .mockRejectedValueOnce(dupError('12340001'))
    .mockResolvedValueOnce(record('12340001', 'c'))
  const { screen } = await beginEnroll()
  await enrolOneKey(screen, 'Desk')
  await act(async () => fireEvent.press(screen.getByText('vault_more_add')))

  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '654321')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByText('vault_err_key_already_enrolled:{"nickname":"Desk"}')).toBeTruthy()
  expect(screen.getByText('vault_key_use_different')).toBeTruthy()

  // Set it up again: the duplicate's serial is dropped from pendingSerials so
  // the service regenerates, and the new record REPLACES the pending one.
  await act(async () => fireEvent.press(screen.getByText('vault_key_setup_again')))
  await settle()
  expect(mockEnrollKey).toHaveBeenLastCalledWith(expect.objectContaining({ pendingSerials: [] }))
  fireEvent.changeText(screen.getByLabelText('vault_name_title'), 'Desk again')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByText('Desk again · …0001')).toBeTruthy()
  expect(screen.queryByText('Desk · …0001')).toBeNull()
  expect(screen.getByText('vault_more_need_two')).toBeTruthy()
})

test('a duplicate of an already-enrolled key (add-key mode) has no Set it up again', async () => {
  mockMeta = { v: 5, createdAt: 1, keys: [{ ...record('12340001', 'a'), nickname: 'Desk' }, { ...record('12340002', 'b'), nickname: 'Safe' }] }
  mockEnrollKey.mockRejectedValueOnce(dupError('12340002'))
  const screen = render(<EnrollWizard mode="add-key" onDone={jest.fn()} onCancel={jest.fn()} />)
  await settle()
  expect(screen.getByText('vault_key_step_title:{"k":3}')).toBeTruthy()
  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '654321')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(mockEnrollKey).toHaveBeenCalledWith(expect.objectContaining({ pendingSerials: ['12340001', '12340002'] }))
  expect(screen.getByText('vault_err_key_already_enrolled:{"nickname":"Safe"}')).toBeTruthy()
  expect(screen.queryByText('vault_key_setup_again')).toBeNull()
})

test('enroll mode refuses a card the stored meta already holds, without counting it toward the ordinal', async () => {
  // A meta under a not-enrolled hero is a host-state anomaly (spec §3.3 step 2
  // still says refuse): its serials go to enrollKey, which refuses BEFORE it
  // spends the PIN or regenerates the slot; k stays 1 because Finish overwrites.
  mockMeta = { v: 5, createdAt: 1, keys: [{ ...record('META0001', 'm'), nickname: 'Old desk' }] }
  mockEnrollKey.mockRejectedValueOnce(dupError('META0001'))
  const { screen } = await beginEnroll()
  expect(screen.getByText('vault_key_step_title:{"k":1}')).toBeTruthy()

  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '654321')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(mockEnrollKey).toHaveBeenCalledTimes(1)
  expect(mockEnrollKey.mock.calls[0][0].pendingSerials).toEqual(['META0001'])
  expect(screen.getByText('vault_err_key_already_enrolled:{"nickname":"Old desk"}')).toBeTruthy()
  expect(screen.getByText('vault_key_use_different')).toBeTruthy()
  expect(screen.queryByText('vault_key_setup_again')).toBeNull()
})

test('hardware back on the enroll done step completes via onDone, with no leave-confirm', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a')).mockResolvedValueOnce(record('12340002', 'b'))
  const { screen, onDone, onCancel } = await beginEnroll()
  await enrolOneKey(screen, 'Desk')
  await act(async () => fireEvent.press(screen.getByText('vault_more_add')))
  await enrolOneKey(screen, 'Safe')
  await act(async () => fireEvent.press(screen.getByText('vault_more_finish')))
  await settle()
  expect(screen.getByText('vault_done_cta')).toBeTruthy()

  expect(await pressBack()).toBe(true)
  expect(onDone).toHaveBeenCalledTimes(1)
  expect(onCancel).not.toHaveBeenCalled()
  expect(mockShowAlert).not.toHaveBeenCalled()
})

test('hardware back on the add-key done step hands off to the re-lock prompt via onDone', async () => {
  mockMeta = { v: 5, createdAt: 1, keys: [{ ...record('12340001', 'a'), nickname: 'Desk' }, { ...record('12340002', 'b'), nickname: 'Safe' }] }
  mockEnrollKey.mockResolvedValueOnce(record('12340003', 'c'))
  const onDone = jest.fn()
  const onCancel = jest.fn()
  const screen = render(<EnrollWizard mode="add-key" onDone={onDone} onCancel={onCancel} />)
  await settle()
  await enrolOneKey(screen, 'Car')
  expect(screen.getByText('vault_relock_now')).toBeTruthy()

  expect(await pressBack()).toBe(true)
  expect(onDone).toHaveBeenCalledTimes(1)
  expect(onCancel).not.toHaveBeenCalled()
  expect(mockShowAlert).not.toHaveBeenCalled()
})

test('hardware back is swallowed while a tap is in flight; the resolved record still reaches the name step', async () => {
  let resolveTap!: (r: ReturnType<typeof record>) => void
  mockEnrollKey.mockImplementationOnce(() => new Promise(r => { resolveTap = r }))
  const { screen, onCancel } = await beginEnroll()
  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '654321')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByText('vault_reading_key')).toBeTruthy()
  // No way out is offered on the tap screen: neither leave link variant.
  expect(screen.queryByText('vault_cancel')).toBeNull()
  expect(screen.queryByText('vault_leave_setup')).toBeNull()

  expect(await pressBack()).toBe(true)
  expect(onCancel).not.toHaveBeenCalled()
  expect(mockShowAlert).not.toHaveBeenCalled()
  expect(screen.getByText('vault_reading_key')).toBeTruthy()

  await act(async () => {
    resolveTap(record('12340001', 'a'))
  })
  await settle()
  expect(screen.getByLabelText('vault_name_title')).toBeTruthy()
})

test('a blocked PIN keeps the pending keys and offers a different YubiKey or a retry', async () => {
  mockEnrollKey
    .mockResolvedValueOnce(record('12340001', 'a'))
    .mockRejectedValueOnce(new VaultError('pin-locked'))
    .mockResolvedValueOnce(record('12340002', 'b'))
  const { screen } = await beginEnroll()
  await enrolOneKey(screen, 'Desk')
  await act(async () => fireEvent.press(screen.getByText('vault_more_add')))
  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '654321')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByText('vault_err_pin_locked_enroll')).toBeTruthy()
  expect(screen.getByText('vault_key_use_different')).toBeTruthy()
  await act(async () => fireEvent.press(screen.getByText('vault_retry')))
  await settle()
  expect(mockEnrollKey).toHaveBeenCalledTimes(3)
  expect(screen.getByLabelText('vault_name_title')).toBeTruthy()
})

test('a wrong PIN returns to the PIN field with the attempts left', async () => {
  mockEnrollKey.mockRejectedValueOnce(new VaultError('pin-invalid', undefined, 2))
  const { screen } = await beginEnroll()
  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '111111')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByText('vault_err_pin_invalid vault_pin_retries:{"count":2}')).toBeTruthy()
  expect(screen.getByLabelText('vault_enter_pin')).toBeTruthy()
})

test('the factory PIN demands a new PIN before the tap and passes both to enrollKey', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a'))
  const { screen } = await beginEnroll()
  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '123456')
  expect(screen.getByLabelText('vault_set_new_pin')).toBeTruthy()
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  expect(mockEnrollKey).not.toHaveBeenCalled()
  fireEvent.changeText(screen.getByLabelText('vault_set_new_pin'), '778899')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  const args = mockEnrollKey.mock.calls[0][0]
  await expect(args.getPin()).resolves.toBe('123456')
  await expect(args.requestPinChange(3)).resolves.toEqual({ oldPin: '123456', newPin: '778899' })
})

test('leaving with a pending key asks first; Stay keeps the wizard, Leave cancels it', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a'))
  const { screen, onCancel } = await beginEnroll()
  await enrolOneKey(screen, 'Desk')

  mockShowAlert.mockResolvedValueOnce('stay')
  await act(async () => fireEvent.press(screen.getByText('vault_leave_setup')))
  await settle()
  expect(mockShowAlert).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'vault_leave_title', message: 'vault_leave_body:{"count":1}' })
  )
  expect(onCancel).not.toHaveBeenCalled()
  expect(screen.getByText('vault_more_title')).toBeTruthy()

  mockShowAlert.mockResolvedValueOnce('leave')
  await act(async () => fireEvent.press(screen.getByText('vault_leave_setup')))
  await settle()
  expect(onCancel).toHaveBeenCalledTimes(1)
})

test('leaving with nothing pending cancels without asking', async () => {
  const { screen, onCancel } = await beginEnroll()
  await act(async () => fireEvent.press(screen.getByText('vault_cancel')))
  await settle()
  expect(mockShowAlert).not.toHaveBeenCalled()
  expect(onCancel).toHaveBeenCalledTimes(1)
})

test('add-key mode runs one key step, calls addVaultKey and ends on the re-lock hint', async () => {
  mockMeta = { v: 5, createdAt: 1, keys: [{ ...record('12340001', 'a'), nickname: 'Desk' }, { ...record('12340002', 'b'), nickname: 'Safe' }] }
  mockEnrollKey.mockResolvedValueOnce(record('12340003', 'c'))
  const onDone = jest.fn()
  const screen = render(<EnrollWizard mode="add-key" onDone={onDone} onCancel={jest.fn()} />)
  await settle()
  expect(screen.queryByText('vault_intro_title')).toBeNull()
  await enrolOneKey(screen, 'Car')
  expect(mockAddVaultKey).toHaveBeenCalledWith(expect.objectContaining({ serial: '12340003', nickname: 'Car' }))
  expect(mockShowToast).toHaveBeenCalledWith('vault_key_added_toast', { type: 'success' })
  expect(screen.getByText('vault_add_key_done:{"nickname":"Car"}')).toBeTruthy()
  fireEvent.press(screen.getByText('vault_relock_now'))
  expect(onDone).toHaveBeenCalledTimes(1)
  expect(mockFinalize).not.toHaveBeenCalled()
})

test('Add another key disappears once five keys are set up', async () => {
  mockEnrollKey
    .mockResolvedValueOnce(record('12340001', 'a'))
    .mockResolvedValueOnce(record('12340002', 'b'))
    .mockResolvedValueOnce(record('12340003', 'c'))
    .mockResolvedValueOnce(record('12340004', 'd'))
    .mockResolvedValueOnce(record('12340005', 'e'))
  const { screen } = await beginEnroll()
  for (let i = 1; i <= 5; i++) {
    if (i > 1) await act(async () => fireEvent.press(screen.getByText('vault_more_add')))
    await enrolOneKey(screen, `K${i}`)
  }
  expect(screen.queryByText('vault_more_add')).toBeNull()
  expect(screen.getByText('vault_more_finish')).toBeTruthy()
})
