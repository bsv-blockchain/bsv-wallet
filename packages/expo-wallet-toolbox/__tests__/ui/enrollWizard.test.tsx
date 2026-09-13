import React from 'react'
import { BackHandler } from 'react-native'
import { act, fireEvent, render } from '@testing-library/react-native'

const mockT = (k: string, o?: Record<string, unknown>) => (o && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k)
const mockEnrollKey = jest.fn()
const mockFinalize = jest.fn()
const mockAddVaultKey = jest.fn()
const mockResumeEnrollmentDraft = jest.fn()
const mockResetPiv = jest.fn()
const mockAcrossChains = jest.fn()
const mockShowAlert = jest.fn()
const mockShowToast = jest.fn()
let mockMeta: unknown = null
let mockDrafts: unknown[] = []
let mockQuarantines: unknown[] = []

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} }),
  i18n: { t: (k: string, o?: Record<string, unknown>) => mockT(k, o) },
  VaultError: jest.requireActual('../../core/services/vault/types').VaultError,
  VaultEnrollmentPartialError: class VaultEnrollmentPartialError
    extends jest.requireActual('../../core/services/vault/types').VaultError
  {
    stage: string
    constructor(stage: string) {
      super('enrollment-partial')
      this.stage = stage
    }
  },
  // Real entropy (WebCrypto under Node): the wizard generates the recovery
  // code itself, and stubbing the source would hide a broken generator.
  randomBytes: jest.requireActual('../../core/services/vault/random').randomBytes,
  enrollKey: (...a: unknown[]) => mockEnrollKey(...a),
  resumeEnrollmentDraft: (...a: unknown[]) => mockResumeEnrollmentDraft(...a),
  finalizeEnrollment: (...a: unknown[]) => mockFinalize(...a),
  addVaultKey: (...a: unknown[]) => mockAddVaultKey(...a),
  resetPivApplication: (...a: unknown[]) => mockResetPiv(...a),
  vaultStore: {
    captureScopeToken: () => ({ identityKey: 'scope', chain: 'test', generation: 1 }),
    assertScopeToken: jest.fn(),
    getMeta: async () => mockMeta,
    getEnrollmentDrafts: async () => mockDrafts,
    getEnrollmentQuarantines: async () => mockQuarantines,
    enrolledSerialsAcrossChains: (...a: unknown[]) => mockAcrossChains(...a)
  },
  VAULT_MIN_KEYS: 2,
  VAULT_MAX_KEYS: 5,
  sounds: { vaultOpen: jest.fn(), vaultClose: jest.fn() },
  haptics: { tap: jest.fn(), confirm: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
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

import { EnrollWizard } from '../../ui/components/vault/EnrollWizard'
import { VaultError, type VaultErrorCode } from '../../core/services/vault/types'

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
  mockDrafts = []
  mockQuarantines = []
  mockEnrollKey.mockReset()
  mockResumeEnrollmentDraft.mockReset()
  mockResetPiv.mockReset()
  mockAcrossChains.mockReset().mockResolvedValue([])
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
  fireEvent.press(screen.getByText('vault_intro_piv_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_intro_begin')))
  await settle()
  return { screen, onDone, onCancel }
}

/** From the pin sub-state: choose and confirm a PIN, then advance to the PUK page. */
function choosePin(screen: ReturnType<typeof render>, pin = '654321') {
  fireEvent.changeText(screen.getByLabelText('vault_pin_choose_title'), pin)
  fireEvent.changeText(screen.getByLabelText('vault_pin_confirm_label'), pin)
}

/** From the pin sub-state: choose a PIN, accept the generated code, reach the tap. */
function enterCredentials(screen: ReturnType<typeof render>, pin = '654321') {
  choosePin(screen, pin)
  fireEvent.press(screen.getByText('vault_continue'))
  fireEvent.press(screen.getByText('vault_puk_ack'))
}

async function enrolOneKey(screen: ReturnType<typeof render>, name: string) {
  const pivAck = screen.queryByText('vault_intro_piv_ack')
  if (pivAck) fireEvent.press(pivAck)
  enterCredentials(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  fireEvent.changeText(screen.getByLabelText('vault_name_title'), name)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
}

test('Begin is inert until both the recovery and whole-PIV acknowledgements are ticked', async () => {
  const screen = render(<EnrollWizard mode="enroll" onDone={jest.fn()} onCancel={jest.fn()} />)
  await settle()
  await act(async () => fireEvent.press(screen.getByText('vault_intro_begin')))
  expect(screen.queryByText('vault_key_step_title:{"k":1}')).toBeNull()
  fireEvent.press(screen.getByText('vault_intro_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_intro_begin')))
  expect(screen.queryByText('vault_key_step_title:{"k":1}')).toBeNull()
  fireEvent.press(screen.getByText('vault_intro_piv_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_intro_begin')))
  await settle()
  expect(screen.getByText('vault_key_step_title:{"k":1}')).toBeTruthy()
})

test('the PIN page shows step 1 of 4 and no PUK fields', async () => {
  const { screen } = await beginEnroll()
  expect(screen.getByText('vault_setup_step:{"n":1,"total":4}')).toBeTruthy()
  expect(screen.queryByLabelText('vault_enter_puk')).toBeNull()
  expect(screen.queryByLabelText('vault_set_new_puk')).toBeNull()
})

test('Continue stays inert until both PIN fields match a valid non-default code', async () => {
  const { screen } = await beginEnroll()
  const cont = () => screen.getByText('vault_continue')

  fireEvent.changeText(screen.getByLabelText('vault_pin_choose_title'), '654321')
  await act(async () => fireEvent.press(cont()))
  expect(screen.queryByText('vault_puk_title')).toBeNull()

  fireEvent.changeText(screen.getByLabelText('vault_pin_confirm_label'), '654322')
  await act(async () => fireEvent.press(cont()))
  expect(screen.getByText('vault_pin_mismatch')).toBeTruthy()
  expect(screen.queryByText('vault_puk_title')).toBeNull()

  fireEvent.changeText(screen.getByLabelText('vault_pin_confirm_label'), '654321')
  await act(async () => fireEvent.press(cont()))
  await settle()
  expect(screen.getByText('vault_puk_title')).toBeTruthy()
})

test('a too-short PIN says why instead of leaving Continue silently inert', async () => {
  const { screen } = await beginEnroll()
  fireEvent.changeText(screen.getByLabelText('vault_pin_choose_title'), '1234')
  fireEvent.changeText(screen.getByLabelText('vault_pin_confirm_label'), '1234')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  // The length rule doubles as the error, so it is on screen twice: the hint
  // under the field, and the message under the pair.
  expect(screen.getAllByText('vault_pin_choose_sub')).toHaveLength(2)
  expect(screen.queryByText('vault_puk_title')).toBeNull()
})

test('the factory PIN is refused as a choice', async () => {
  const { screen } = await beginEnroll()
  fireEvent.changeText(screen.getByLabelText('vault_pin_choose_title'), '123456')
  fireEvent.changeText(screen.getByLabelText('vault_pin_confirm_label'), '123456')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  expect(screen.getByText('vault_pin_not_default')).toBeTruthy()
  expect(screen.queryByText('vault_puk_title')).toBeNull()
})

test('restores ready scoped drafts into pending without touching the YubiKeys again', async () => {
  mockDrafts = [
    { record: { ...record('DRAFT001', 'a'), nickname: 'Desk' }, assurance: 'ready' },
    { record: { ...record('DRAFT002', 'b'), nickname: 'Safe' }, assurance: 'ready' }
  ]
  const { screen } = await beginEnroll()
  expect(screen.getByText('vault_more_title')).toBeTruthy()
  expect(screen.getByText('Desk · …T001')).toBeTruthy()
  expect(screen.getByText('Safe · …T002')).toBeTruthy()
  expect(mockEnrollKey).not.toHaveBeenCalled()
})

test('resumes a protected draft with a live PIN challenge before naming it', async () => {
  const draft = { record: record('DRAFT001', 'a'), assurance: 'challenge-required' as const }
  mockDrafts = [draft]
  mockResumeEnrollmentDraft.mockResolvedValueOnce(draft.record)
  const { screen } = await beginEnroll()
  // The resume button lives on the PIN page, so stop there rather than
  // advancing to the recovery-code page.
  choosePin(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_enrollment_resume · …T001')))
  await settle()
  expect(mockResumeEnrollmentDraft).toHaveBeenCalledWith(expect.objectContaining({ entry: draft }))
  await expect(mockResumeEnrollmentDraft.mock.calls[0][0].getPin()).resolves.toBe('654321')
  expect(screen.getByLabelText('vault_name_title')).toBeTruthy()
  expect(mockEnrollKey).not.toHaveBeenCalled()
})

test('surfaces quarantined personalization and offers no blind retry', async () => {
  mockQuarantines = [{ serial: 'BLOCK001', stage: 'puk-change-uncertain', recordedAt: 1 }]
  const screen = render(<EnrollWizard mode="enroll" onDone={jest.fn()} onCancel={jest.fn()} />)
  await settle()
  // The hedged copy, not the reset-required one: a quarantine can be recorded
  // before the card is touched, so the banner must not claim it is non-factory.
  expect(screen.getByText('vault_enrollment_state_uncertain')).toBeTruthy()
  expect(screen.queryByText(/vault_enrollment_resume/)).toBeNull()
})

test.each(['pin-change-uncertain', 'pin-changed', 'puk-change-uncertain', 'puk-changed', 'generation-uncertain'])(
  'a %s partial never retries generic enrollment on the same PIV application',
  async stage => {
    const Partial = jest.requireMock('@bsv/expo-wallet-toolbox').VaultEnrollmentPartialError
    mockEnrollKey.mockRejectedValueOnce(new Partial(stage))
    const { screen } = await beginEnroll()
    enterCredentials(screen)
    await act(async () => fireEvent.press(screen.getByText('vault_continue')))
    await settle()
    expect(screen.getByText('vault_enrollment_state_uncertain')).toBeTruthy()
    expect(screen.getByText('vault_key_use_different')).toBeTruthy()
    expect(screen.queryByText('vault_retry')).toBeNull()
  }
)

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

test('a duplicate pending key is never regenerated or replaced', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a')).mockRejectedValueOnce(dupError('12340001'))
  const { screen } = await beginEnroll()
  await enrolOneKey(screen, 'Desk')
  await act(async () => fireEvent.press(screen.getByText('vault_more_add')))

  enterCredentials(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByText('vault_err_key_already_enrolled:{"nickname":"Desk"}')).toBeTruthy()
  expect(screen.getByText('vault_key_use_different')).toBeTruthy()
  expect(screen.queryByText('vault_key_setup_again')).toBeNull()
  await act(async () => fireEvent.press(screen.getByText('vault_key_use_different')))
  await settle()
  expect(screen.getByText('vault_key_step_title:{"k":2}')).toBeTruthy()
  expect(mockEnrollKey).toHaveBeenCalledTimes(2)
})

test('a duplicate of an already-enrolled key (add-key mode) has no Set it up again', async () => {
  mockMeta = {
    v: 5,
    createdAt: 1,
    keys: [
      { ...record('12340001', 'a'), nickname: 'Desk' },
      { ...record('12340002', 'b'), nickname: 'Safe' }
    ]
  }
  mockEnrollKey.mockRejectedValueOnce(dupError('12340002'))
  const screen = render(<EnrollWizard mode="add-key" onDone={jest.fn()} onCancel={jest.fn()} />)
  await settle()
  expect(screen.getByText('vault_key_step_title:{"k":3}')).toBeTruthy()
  fireEvent.press(screen.getByText('vault_intro_piv_ack'))
  enterCredentials(screen)
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

  enterCredentials(screen)
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
  mockMeta = {
    v: 5,
    createdAt: 1,
    keys: [
      { ...record('12340001', 'a'), nickname: 'Desk' },
      { ...record('12340002', 'b'), nickname: 'Safe' }
    ]
  }
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
  mockEnrollKey.mockImplementationOnce(
    () =>
      new Promise(r => {
        resolveTap = r
      })
  )
  const { screen, onCancel } = await beginEnroll()
  enterCredentials(screen)
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
  enterCredentials(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByText('vault_err_pin_locked_enroll')).toBeTruthy()
  expect(screen.getByText('vault_key_use_different')).toBeTruthy()
  await act(async () => fireEvent.press(screen.getByText('vault_retry')))
  await settle()
  expect(mockEnrollKey).toHaveBeenCalledTimes(3)
  expect(screen.getByLabelText('vault_name_title')).toBeTruthy()
})

test('an occupied Vault slot requires explicit replacement and retries with consent', async () => {
  mockEnrollKey.mockRejectedValueOnce(new VaultError('slot-occupied')).mockResolvedValueOnce(record('12340001', 'b'))
  const { screen } = await beginEnroll()
  enterCredentials(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()

  expect(screen.getByText('vault_replace_key_warning')).toBeTruthy()
  expect(mockEnrollKey.mock.calls[0][0].replaceOccupiedVaultSlot).toBe(false)
  await act(async () => fireEvent.press(screen.getByText('vault_replace_key_confirm')))
  await settle()

  expect(mockEnrollKey.mock.calls[1][0].replaceOccupiedVaultSlot).toBe(true)
  expect(screen.getByLabelText('vault_name_title')).toBeTruthy()
})

test('a card whose PIV PIN is not the factory one is sent away, never retried', async () => {
  // The wizard supplies '123456' itself, so pin-invalid means the card is not
  // factory-reset. Offering a retry would present '123456' again and walk three
  // failures into pin-locked.
  mockEnrollKey.mockRejectedValueOnce(new VaultError('pin-invalid', undefined, 2))
  const { screen } = await beginEnroll()
  enterCredentials(screen, '111111')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByText('vault_enrollment_reset_required')).toBeTruthy()
  expect(screen.getByText('vault_key_use_different')).toBeTruthy()
  expect(screen.queryByText('vault_retry')).toBeNull()
  expect(screen.queryByText(/vault_pin_retries/)).toBeNull()
  expect(screen.queryByLabelText('vault_pin_choose_title')).toBeNull()
  expect(mockEnrollKey).toHaveBeenCalledTimes(1)
})

test('the recovery code page shows step 2 of 4 and gates Continue on the acknowledgement', async () => {
  const { screen } = await beginEnroll()
  choosePin(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()

  expect(screen.getByText('vault_puk_title')).toBeTruthy()
  expect(screen.getByText('vault_setup_step:{"n":2,"total":4}')).toBeTruthy()

  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  expect(mockEnrollKey).not.toHaveBeenCalled()

  fireEvent.press(screen.getByText('vault_puk_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(mockEnrollKey).toHaveBeenCalled()
})

test('the factory codes are supplied below the UI and the generated PUK is 8 digits', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a'))
  const { screen } = await beginEnroll()
  enterCredentials(screen, '778899')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()

  const args = mockEnrollKey.mock.calls[0][0]
  expect(args.acknowledgeDedicatedPivApplication).toBe(true)
  await expect(args.getPin()).resolves.toBe('123456')
  await expect(args.requestPinChange(3)).resolves.toEqual({ oldPin: '123456', newPin: '778899' })
  const puk = await args.requestPukChange()
  expect(puk.oldPuk).toBe('12345678')
  expect(puk.newPuk).toMatch(/^[0-9]{8}$/)
  expect(puk.newPuk).not.toBe('12345678')
  expect(puk.newPuk).not.toBe('778899')
})

test('the recovery code is announced digit by digit, not swallowed by the heading', async () => {
  const { screen } = await beginEnroll()
  choosePin(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()

  const shown = screen.getByTestId('vault-recovery-code')
  const digits = shown.props.children as string
  // An accessibilityLabel replaces the content, so it must be the digits —
  // spaced, so they are read one at a time rather than as one big number.
  expect(shown.props.accessibilityLabel).toBe(digits.split('').join(' '))
  expect(screen.queryByLabelText('vault_puk_title')).toBeNull()
})

test('going back and forward again keeps the code the user was told to write down', async () => {
  const { screen } = await beginEnroll()
  choosePin(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  const first = screen.getByTestId('vault-recovery-code').props.children as string

  await act(async () => fireEvent.press(screen.getByText('vault_back')))
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByTestId('vault-recovery-code').props.children).toBe(first)
})

test('a PIN changed to equal the shown code draws a fresh code instead of dead-ending', async () => {
  // validatePukChange refuses newPuk === pin before the session opens, and the
  // error page would offer only a Retry that fails identically forever.
  const { screen } = await beginEnroll()
  choosePin(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  const first = screen.getByTestId('vault-recovery-code').props.children as string

  await act(async () => fireEvent.press(screen.getByText('vault_back')))
  fireEvent.changeText(screen.getByLabelText('vault_pin_choose_title'), first)
  fireEvent.changeText(screen.getByLabelText('vault_pin_confirm_label'), first)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()

  const second = screen.getByTestId('vault-recovery-code').props.children as string
  expect(second).toMatch(/^[0-9]{8}$/)
  expect(second).not.toBe(first)
})

test('the code shown on screen is the one sent to the service', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a'))
  const { screen } = await beginEnroll()
  choosePin(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()

  const shown = screen.getByTestId('vault-recovery-code').props.children as string
  fireEvent.press(screen.getByText('vault_puk_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()

  await expect(mockEnrollKey.mock.calls[0][0].requestPukChange()).resolves.toEqual({
    oldPuk: '12345678',
    newPuk: shown
  })
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
  mockMeta = {
    v: 5,
    createdAt: 1,
    keys: [
      { ...record('12340001', 'a'), nickname: 'Desk' },
      { ...record('12340002', 'b'), nickname: 'Safe' }
    ]
  }
  mockEnrollKey.mockResolvedValueOnce(record('12340003', 'c'))
  const onDone = jest.fn()
  const screen = render(<EnrollWizard mode="add-key" onDone={onDone} onCancel={jest.fn()} />)
  await settle()
  expect(screen.queryByText('vault_intro_title')).toBeNull()
  await enrolOneKey(screen, 'Car')
  expect(mockAddVaultKey).toHaveBeenCalledWith(
    expect.objectContaining({ serial: '12340003', nickname: 'Car' }),
    expect.anything()
  )
  expect(mockShowToast).toHaveBeenCalledWith('vault_key_added_toast', { type: 'success' })
  expect(screen.getByText('vault_add_key_done:{"nickname":"Car"}')).toBeTruthy()
  fireEvent.press(screen.getByText('vault_relock_now'))
  expect(onDone).toHaveBeenCalledTimes(1)
  expect(mockFinalize).not.toHaveBeenCalled()
})

// ── the in-app PIV reset ──────────────────────────────────────────────
//
// The destructive end of the wizard. Every test below is written so that it
// fails if the guard it names is removed: the refusals carry a positive
// control in the same test, so "no reset offered" can never pass merely
// because the feature is absent.

/** Walk to the tap, and have it fail with `code` (optionally carrying details). */
async function failTapWith(code: VaultErrorCode, details?: Record<string, string>) {
  mockEnrollKey.mockRejectedValueOnce(new VaultError(code, undefined, undefined, details))
  const { screen, onCancel } = await beginEnroll()
  enterCredentials(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  return { screen, onCancel }
}

/** From a failed tap, take the reset offer and land on the reset page. */
async function openResetPage(code: VaultErrorCode = 'mgmt-key-custom', serial = '12340001') {
  const ctx = await failTapWith(code, { serial })
  fireEvent.press(ctx.screen.getByText('vault_reset_offer'))
  await settle()
  return ctx
}

const pressConfirm = async (screen: ReturnType<typeof render>) => {
  await act(async () => fireEvent.press(screen.getByText('vault_reset_confirm')))
  await settle()
}

/**
 * Whether the destructive button reports itself disabled to the a11y tree.
 *
 * The button is gated in two places — `enabled=` in the render and a `return`
 * at the top of `runReset` — so "resetPivApplication was not called" passes
 * with either layer alone and cannot see a single-layer regression. This pins
 * the render layer by itself. The handler-side `return` is defence in depth
 * and is not independently observable through the UI: while the render gate
 * holds, `onPress` is undefined and there is no way to reach the handler.
 */
const confirmDisabled = (screen: ReturnType<typeof render>) => {
  let node = screen.getByText('vault_reset_confirm').parent
  while (node && node.props?.accessibilityState === undefined) node = node.parent
  return node?.props.accessibilityState?.disabled
}

test.each<VaultErrorCode>([
  'mgmt-key-custom',
  'pin-invalid',
  'puk-invalid',
  'pin-locked',
  'puk-locked',
  'slot-occupied'
])('%s offers a reset when the serial is known', async code => {
  const { screen } = await failTapWith(code, { serial: '12340001' })
  expect(screen.getByText('vault_reset_offer')).toBeTruthy()
})

test('a counterfeit key is never offered a reset', async () => {
  // Positive control first, same serial: without it this assertion would also
  // pass if the offer never rendered anywhere.
  const control = await failTapWith('mgmt-key-custom', { serial: '12340001' })
  expect(control.screen.getByText('vault_reset_offer')).toBeTruthy()
  control.screen.unmount()

  const { screen } = await failTapWith('attestation-invalid', { serial: '12340001' })
  expect(screen.queryByText('vault_reset_offer')).toBeNull()
  // And no Retry: the F9 chain failed, so re-tapping the same token can only
  // fail again, under copy that already says to fetch a genuine key.
  expect(screen.getByText('vault_key_use_different')).toBeTruthy()
  expect(screen.queryByText('vault_retry')).toBeNull()
})

test('an already-enrolled key is never offered a reset', async () => {
  const control = await failTapWith('mgmt-key-custom', { serial: '12340001' })
  expect(control.screen.getByText('vault_reset_offer')).toBeTruthy()
  control.screen.unmount()

  const { screen } = await failTapWith('key-already-enrolled', { serial: '12340001' })
  expect(screen.queryByText('vault_reset_offer')).toBeNull()
})

test('without a serial there is nothing to bind a reset to, so none is offered', async () => {
  const { screen } = await failTapWith('mgmt-key-custom')
  expect(screen.queryByText('vault_reset_offer')).toBeNull()
  // The same code WITH a serial does offer one (above), so this is the missing
  // binding and not the feature simply being absent. A custom management key
  // cannot be retried into success either, so the only way on is another card.
  expect(screen.getByText('vault_key_use_different')).toBeTruthy()
  expect(screen.queryByText('vault_retry')).toBeNull()
})

test('a card with a known serial gets both the reset and a way past it', async () => {
  const { screen } = await failTapWith('mgmt-key-custom', { serial: '12340001' })
  expect(screen.getByText('vault_reset_offer')).toBeTruthy()
  expect(screen.getByText('vault_key_use_different')).toBeTruthy()
})

test('the reset page gates the destructive button on the acknowledgement', async () => {
  const { screen } = await openResetPage()

  expect(screen.getByText('vault_reset_title')).toBeTruthy()
  // Render layer, pinned on its own.
  expect(confirmDisabled(screen)).toBe(true)
  await pressConfirm(screen)
  expect(mockResetPiv).not.toHaveBeenCalled()

  fireEvent.press(screen.getByText('vault_reset_ack'))
  expect(confirmDisabled(screen)).toBe(false)
  await pressConfirm(screen)
  expect(mockResetPiv).toHaveBeenCalledWith(
    expect.objectContaining({
      serial: '12340001',
      acknowledgeDestroysAllCredentials: true
    })
  )
})

test('a successful reset returns to the tap step without re-asking for the PIN', async () => {
  mockResetPiv.mockResolvedValueOnce(undefined)
  const { screen } = await openResetPage()
  // Queued after the failing tap so it is the RE-tap that succeeds.
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a'))

  fireEvent.press(screen.getByText('vault_reset_ack'))
  await pressConfirm(screen)

  expect(screen.queryByLabelText('vault_pin_choose_title')).toBeNull()
  expect(mockEnrollKey).toHaveBeenCalledTimes(2)
  // The same PIN and recovery code, because the card is back at factory state
  // and neither was ever written to it.
  await expect(mockEnrollKey.mock.calls[1][0].requestPinChange()).resolves.toEqual({
    oldPin: '123456',
    newPin: '654321'
  })
})

test('the reset passes stored AND pending serials so a vault key can never be erased', async () => {
  mockMeta = { v: 5, createdAt: 1, keys: [record('99990001', 'z')] }
  mockEnrollKey
    .mockResolvedValueOnce(record('12340001', 'a'))
    .mockRejectedValueOnce(new VaultError('mgmt-key-custom', undefined, undefined, { serial: '12340002' }))
    .mockResolvedValueOnce(record('12340002', 'b'))
  mockResetPiv.mockResolvedValueOnce(undefined)

  const { screen } = await beginEnroll()
  await enrolOneKey(screen, 'Desk')
  await act(async () => fireEvent.press(screen.getByText('vault_more_add')))
  enterCredentials(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()

  fireEvent.press(screen.getByText('vault_reset_offer'))
  await settle()
  fireEvent.press(screen.getByText('vault_reset_ack'))
  await pressConfirm(screen)

  const args = mockResetPiv.mock.calls[0][0]
  expect(args.serial).toBe('12340002')
  // Stored meta AND this run's not-yet-persisted key. Dropping either half
  // silently removes half of pivReset's enrolled-key refusal.
  expect(args.refuseSerials).toEqual(expect.arrayContaining(['99990001', '12340001']))
})

test('an unrecognized vault key on the card takes its own second consent', async () => {
  mockResetPiv
    .mockRejectedValueOnce(new VaultError('slot-occupied', undefined, undefined, { serial: '12340001' }))
    .mockResolvedValueOnce(undefined)
  const { screen } = await openResetPage()
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a'))

  fireEvent.press(screen.getByText('vault_reset_ack'))
  await pressConfirm(screen)
  // The "erases everything" tick is NOT consent to wiping a vault key this
  // device cannot account for. The first attempt must never pre-suppose it.
  expect(mockResetPiv.mock.calls[0][0].acknowledgeUnrecognizedVaultKey).toBeUndefined()

  expect(screen.getByText('vault_reset_unknown_ack')).toBeTruthy()
  await pressConfirm(screen)
  expect(mockResetPiv).toHaveBeenCalledTimes(1)

  fireEvent.press(screen.getByText('vault_reset_unknown_ack'))
  await pressConfirm(screen)
  expect(mockResetPiv).toHaveBeenCalledTimes(2)
  expect(mockResetPiv.mock.calls[1][0].acknowledgeUnrecognizedVaultKey).toBe(true)
})

test('the refused first attempt reports that nothing was erased', async () => {
  // pivReset guard 3 runs before the RESET APDU, so this is the one rejection
  // where the card is provably untouched — and the user has just pressed a
  // destructive button and watched a card session open and close.
  mockResetPiv.mockRejectedValueOnce(new VaultError('slot-occupied', undefined, undefined, { serial: '12340001' }))
  const { screen } = await openResetPage()

  fireEvent.press(screen.getByText('vault_reset_ack'))
  await pressConfirm(screen)

  expect(screen.getByText('vault_reset_nothing_erased')).toBeTruthy()
  expect(confirmDisabled(screen)).toBe(true)
})

test('a key holding this device’s own draft is not called an unrecognized vault key', async () => {
  // The draft belongs to a partial enrollment this device recorded, so the
  // unknown-vault wording would be false — and teaching the user to tick the
  // one overridable guard for their own half-finished key is how they come to
  // tick it by reflex for somebody else's live one.
  mockDrafts = [{ record: record('12340001', 'a'), assurance: 'challenge-required' }]
  mockResetPiv.mockRejectedValueOnce(new VaultError('slot-occupied', undefined, undefined, { serial: '12340001' }))
  const { screen } = await openResetPage()

  fireEvent.press(screen.getByText('vault_reset_ack'))
  await pressConfirm(screen)

  expect(screen.getByText('vault_reset_own_draft_ack')).toBeTruthy()
  expect(screen.queryByText('vault_reset_unknown_ack')).toBeNull()
  // And the non-destructive way out, with the PIN warning attached.
  expect(screen.getByText('vault_enrollment_resume · …0001')).toBeTruthy()
  expect(screen.getAllByText('vault_enrollment_resume_pin_hint').length).toBeGreaterThan(0)
})

test('a reset offer never survives onto a different card’s failure', async () => {
  // Card A fails a partial carrying its serial, so a reset is offered for A.
  // Try again leaves the error page WITHOUT clearing the step, the user then
  // resumes saved card B from the PIN page, and that fails too. The offer on
  // the resulting error page must not still be bound to A — erasing the wrong
  // key is the worst outcome this plan has.
  mockDrafts = [{ record: record('99990002', 'b'), assurance: 'challenge-required' }]
  mockEnrollKey.mockRejectedValueOnce(
    new VaultError('enrollment-partial', undefined, undefined, { serial: '12340001' })
  )
  mockResumeEnrollmentDraft.mockRejectedValueOnce(new VaultError('mgmt-key-custom'))

  const { screen } = await beginEnroll()
  enterCredentials(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByText('vault_reset_offer')).toBeTruthy()

  await act(async () => fireEvent.press(screen.getByText('vault_retry')))
  await settle()
  choosePin(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_enrollment_resume · …0002')))
  await settle()

  // The resume really did run and really did land on the error page — without
  // these the assertion below could pass by never reaching it at all.
  expect(mockResumeEnrollmentDraft).toHaveBeenCalledTimes(1)
  expect(screen.getByText('vault_err_mgmt_key_custom')).toBeTruthy()
  expect(screen.queryByText('vault_reset_offer')).toBeNull()
})

test('a reset drops the Resume button for the key it just erased', async () => {
  // pivReset discards the erased serial's draft and quarantine. A wizard that
  // never re-reads them keeps offering to resume a key that no longer exists.
  mockDrafts = [{ record: record('12340001', 'a'), assurance: 'challenge-required' }]
  mockResetPiv.mockResolvedValueOnce(undefined)
  const { screen } = await openResetPage()
  // The re-tap fails on a code that routes to "use a different YubiKey", which
  // is how the PIN page — where Resume lives — becomes reachable again.
  mockEnrollKey.mockRejectedValueOnce(new VaultError('attestation-invalid'))

  fireEvent.press(screen.getByText('vault_reset_ack'))
  mockDrafts = []
  await pressConfirm(screen)

  await act(async () => fireEvent.press(screen.getByText('vault_key_use_different')))
  await settle()
  expect(screen.getByLabelText('vault_pin_choose_title')).toBeTruthy()
  expect(screen.queryByText(/vault_enrollment_resume/)).toBeNull()
})

test('unreadable vault records refuse the reset before any card contact, and say so', async () => {
  mockAcrossChains.mockReset().mockRejectedValue(new VaultError('template-invalid', 'corrupt (teratest)'))
  const { screen } = await openResetPage()

  fireEvent.press(screen.getByText('vault_reset_ack'))
  await pressConfirm(screen)

  expect(mockResetPiv).not.toHaveBeenCalled()
  expect(screen.getByText('vault_err_reset_unreadable')).toBeTruthy()
  expect(screen.queryByText('vault_err_template_invalid')).toBeNull()
})

test('an interrupted reset never claims the key was left untouched', async () => {
  // A lift after the RESET APDU rejects on a card that is already factory, and
  // no code distinguishes it from a refusal before contact.
  mockResetPiv.mockRejectedValueOnce(new VaultError('key-removed-mid-op'))
  const { screen } = await openResetPage()

  fireEvent.press(screen.getByText('vault_reset_ack'))
  await pressConfirm(screen)

  expect(screen.getByText('vault_reset_uncertain')).toBeTruthy()
  expect(screen.queryByText('vault_err_key_removed_mid_op')).toBeNull()
})

test('a reset refused as an enrolled key says which mistake was prevented', async () => {
  mockResetPiv.mockRejectedValueOnce(new VaultError('key-already-enrolled', '12340001'))
  const { screen } = await openResetPage()

  fireEvent.press(screen.getByText('vault_reset_ack'))
  await pressConfirm(screen)

  expect(screen.getByText('vault_err_reset_enrolled')).toBeTruthy()
})

test('resuming a saved key asks for that key’s existing PIN, not a new one', async () => {
  // resumeEnrollmentDraft sends the PIN typed here, and the card already
  // carries the one an earlier run set: three guesses lock a real vault key.
  mockDrafts = [{ record: record('DRAFT001', 'a'), assurance: 'challenge-required' }]
  const { screen } = await beginEnroll()
  expect(screen.getByText('vault_enrollment_resume_pin_hint')).toBeTruthy()
})

test('with nothing to resume, the PIN page does not talk about an earlier PIN', async () => {
  const { screen } = await beginEnroll()
  expect(screen.queryByText('vault_enrollment_resume_pin_hint')).toBeNull()
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
