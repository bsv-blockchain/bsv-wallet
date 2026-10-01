/**
 * The Profile screen's handle machine, driven against a scripted registry
 * client and a scripted registration module — the certificate work itself is
 * covered by the handleRegistry suite, and what is under test here is which
 * question the screen asks and what it does with the answer.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? `${key}:${Object.values(values).join(',')}` : key),
    i18n: { language: 'en' }
  }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), dismissAll: jest.fn() },
  useLocalSearchParams: () => ({})
}))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))
const mockShowAlert = jest.fn()
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: (...a: unknown[]) => mockShowAlert(...a) }))
jest.mock('../../ui/resolveIdentity', () => ({
  makeIdentityClient: () => null,
  resolveIdentity: jest.fn()
}))

const mockCheckAvailability = jest.fn()
const mockLookupProfile = jest.fn()
jest.mock('../../core/identity/handleRegistry/client', () => ({
  createHandleRegistryClient: () => ({
    domain: 'deggen.com',
    checkAvailability: mockCheckAvailability,
    lookupProfile: mockLookupProfile
  })
}))

const mockRegisterHandle = jest.fn()
const mockChangeHandle = jest.fn()
const mockUpdateProfile = jest.fn()
const mockResumePending = jest.fn()
jest.mock('../../core/identity/handleRegistry/registration', () => ({
  registerHandle: (...a: unknown[]) => mockRegisterHandle(...a),
  changeHandle: (...a: unknown[]) => mockChangeHandle(...a),
  updateProfile: (...a: unknown[]) => mockUpdateProfile(...a),
  resumePending: (...a: unknown[]) => mockResumePending(...a)
}))

let mockNetwork: 'main' | 'test' = 'test'
let mockProfilesSupported = false
const mockCheckProfileRemoval = jest.fn()
const mockRemoveProfile = jest.fn()
const kv = new Map<string, string>()
/** The one key whose write rejects, the way a locked or full store would. */
let writeFailsFor: string | null = null
const mockStorage = {
  getKeyValue: async (k: string) => kv.get(k),
  setKeyValue: async (k: string, v: string) => {
    if (k === writeFailsFor) throw new Error('kv write failed')
    kv.set(k, v)
  }
}
/**
 * The originator is not decoration. `WalletPermissionsManager.prepareOriginator`
 * throws outright for a missing one — before any signing exemption is even
 * consulted — so a wallet handed to the registration module unbound fails every
 * claim at `getPublicKey`, with no prompt and no certificate. Reproduced here
 * so that wiring is something a test can see.
 */
const mockPermissionsManager = {
  getPublicKey: jest.fn(async (_args: { identityKey: true }, originator?: string) => {
    if (!originator?.trim()) throw new Error('Originator is required for permission checks.')
    return { publicKey: '02' + 'ab'.repeat(32) }
  }),
  createSignature: jest.fn(async (_args: unknown, originator?: string) => {
    if (!originator?.trim()) throw new Error('Originator is required for permission checks.')
    // Minimal well-formed DER (r = 1, s = 1): the SDK parses what it is handed.
    return { signature: [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01] }
  })
}
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({
    managers: { permissionsManager: mockPermissionsManager },
    adminOriginator: 'admin.com',
    storage: mockStorage,
    selectedNetwork: mockNetwork,
    profilesSupported: mockProfilesSupported,
    checkProfileRemoval: (...a: unknown[]) => mockCheckProfileRemoval(...a),
    removeProfile: (...a: unknown[]) => mockRemoveProfile(...a)
  })
}))

import React from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { ThemeProvider, configureToolbox, resetToolboxConfig } from '@bsv/expo-wallet-toolbox'
import { router } from 'expo-router'
import { showToast } from '../../ui/components/ui/Toast'
import {
  MAX_PROFILE_NAME_LENGTH,
  __resetProfilesForTests,
  appendProfile,
  getProfilesState,
  setActiveProfile,
  updateProfile as updateProfileRecord
} from '../../core/profiles/profileStore'
import { buildProfileCertificate, type ProfileSigner } from '../../core/identity/handleRegistry/profileCert'
import { ProfileScreen } from '../../ui/screens/ProfileScreen'

const OWN_KEY = '02' + 'ab'.repeat(32)
/** The screen's `HANDLE_CHECK_DEBOUNCE_MS`, which it does not export. */
const DEBOUNCE_MS = 400
const draw = () =>
  render(
    <ThemeProvider>
      <ProfileScreen />
    </ThemeProvider>
  )

const withRegistry = () =>
  configureToolbox({
    backupUrl: null,
    handleRegistry: { test: { domain: 'deggen.com', url: 'https://registry.example' } }
  })

/** Real timers, as the rest of this file uses: sit out the debounce window. */
const pastTheDebounce = () => act(async () => await new Promise(r => setTimeout(r, DEBOUNCE_MS + 60)))
/** Two turns: one for the promise, one for Node to declare a rejection unhandled. */
const settle = () =>
  act(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })
/** The Claim button carries no label of its own; its state sits on the
 * pressable above its text. */
const claimDisabled = (screen: ReturnType<typeof draw>, label: string) => {
  let node = screen.getByText(label).parent
  while (node && node.props?.accessibilityState === undefined) node = node.parent
  return node?.props.accessibilityState?.disabled
}

beforeEach(() => {
  jest.clearAllMocks()
  kv.clear()
  writeFailsFor = null
  resetToolboxConfig()
  mockNetwork = 'test'
  mockProfilesSupported = false
  __resetProfilesForTests()
  mockResumePending.mockResolvedValue({ kind: 'idle' })
  mockLookupProfile.mockResolvedValue({ kind: 'none' })
  mockCheckAvailability.mockResolvedValue({ kind: 'available' })
})
afterEach(() => resetToolboxConfig())

describe('with no registry on this chain', () => {
  it('says so and offers no input, asking the registry nothing', async () => {
    configureToolbox({ backupUrl: null })
    const s = draw()
    await waitFor(() => expect(s.getByText('profile_handle_unavailable')).toBeTruthy())
    expect(s.queryByPlaceholderText('profile_handle_placeholder')).toBeNull()
    expect(mockResumePending).not.toHaveBeenCalled()
    expect(mockLookupProfile).not.toHaveBeenCalled()
  })
})

describe('the claim field', () => {
  it('takes the local part and shows the configured domain beside it', async () => {
    withRegistry()
    const s = draw()
    await waitFor(() => expect(s.getByPlaceholderText('profile_handle_placeholder')).toBeTruthy())
    expect(s.getByText('@deggen.com')).toBeTruthy()
  })

  it('checks availability once, after the debounce, and names the full paymail', async () => {
    withRegistry()
    const s = draw()
    const input = await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder'))
    fireEvent.changeText(input, 'd')
    fireEvent.changeText(input, 'de')
    fireEvent.changeText(input, 'dee')
    await waitFor(() => expect(s.getByText('profile_handle_available:dee@deggen.com')).toBeTruthy())
    expect(mockCheckAvailability).toHaveBeenCalledTimes(1)
    expect(mockCheckAvailability).toHaveBeenCalledWith('dee')
  })

  it.each([
    ['taken', 'profile_handle_taken:dee@deggen.com'],
    ['too_similar', 'profile_handle_too_similar:dee@deggen.com'],
    ['reserved', 'profile_handle_reserved:dee@deggen.com'],
    ['cooldown', 'profile_handle_cooldown:dee@deggen.com'],
    ['invalid', 'profile_handle_invalid']
  ])('draws its own line for %s', async (reason: string, expected: string) => {
    withRegistry()
    mockCheckAvailability.mockResolvedValue({ kind: 'unavailable', reason })
    const s = draw()
    fireEvent.changeText(await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder')), 'dee')
    await waitFor(() => expect(s.getByText(expected)).toBeTruthy())
  })

  it('offers a retry when the check could not be made', async () => {
    withRegistry()
    mockCheckAvailability.mockResolvedValue({ kind: 'failed' })
    const s = draw()
    fireEvent.changeText(await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder')), 'dee')
    await waitFor(() => expect(s.getByText('profile_handle_failed')).toBeTruthy())
    fireEvent.press(s.getByText('retry'))
    await waitFor(() => expect(mockCheckAvailability).toHaveBeenCalledTimes(2))
  })

  it('discards an answer for text the user has already replaced', async () => {
    withRegistry()
    let release: (value: { kind: string }) => void = () => {}
    mockCheckAvailability
      .mockImplementationOnce(() => new Promise(resolve => (release = resolve)))
      .mockResolvedValue({ kind: 'unavailable', reason: 'taken' })
    const s = draw()
    const input = await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder'))
    fireEvent.changeText(input, 'dee')
    await waitFor(() => expect(mockCheckAvailability).toHaveBeenCalledTimes(1))
    fireEvent.changeText(input, 'deggen')
    await waitFor(() => expect(mockCheckAvailability).toHaveBeenCalledTimes(2))
    release({ kind: 'available' })
    // Flushed, not waited for. `waitFor` runs its callback synchronously on the
    // first iteration, and the fast second check has already put `taken` on
    // screen — so waiting for `taken` here would be satisfied by state that
    // existed before the stale reply could land, and would hold with no nonce
    // guard in the screen at all.
    await settle()
    expect(s.getByText('profile_handle_taken:deggen@deggen.com')).toBeTruthy()
    expect(s.queryByText('profile_handle_available:deggen@deggen.com')).toBeNull()
    // And the consequence, which is the part that moves money: `canClaim` reads
    // the availability the stale reply would have overwritten.
    expect(claimDisabled(s, 'profile_handle_claim:deggen@deggen.com')).toBe(true)
  })

  /**
   * The debounce outlives the screen unless something clears it: leaving
   * Profile mid-word would otherwise still ask the registry, and then answer
   * into a tree that is gone. The nonce only drops superseded replies.
   */
  it('drops a check the user walked away from', async () => {
    withRegistry()
    const s = draw()
    fireEvent.changeText(await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder')), 'dee')
    s.unmount()
    await pastTheDebounce()
    expect(mockCheckAvailability).not.toHaveBeenCalled()
  })

  /**
   * Cancel has to undo the keystroke as well as the mode. A check left running
   * for the abandoned text lands on an empty field and leaves `available` on
   * screen — an enabled Claim button whose press falls straight out at the
   * format guard, which is the one outcome this screen must never have.
   */
  it('drops a check the user cancelled, leaving Claim disabled on the empty field', async () => {
    withRegistry()
    mockLookupProfile.mockResolvedValue({
      kind: 'found',
      profile: { paymail: 'dee@deggen.com', handle: 'dee', domain: 'deggen.com' }
    })
    const s = draw()
    fireEvent.press(await waitFor(() => s.getByText('profile_handle_change')))
    fireEvent.changeText(s.getByPlaceholderText('profile_handle_placeholder'), 'deggen')
    fireEvent.press(s.getByText('cancel'))
    await pastTheDebounce()
    expect(mockCheckAvailability).not.toHaveBeenCalled()

    fireEvent.press(s.getByText('profile_handle_change'))
    expect(claimDisabled(s, 'profile_handle_register_action')).toBe(true)
  })
})

describe('on mount', () => {
  it('finishes anything journalled before asking the registry who we are', async () => {
    withRegistry()
    const order: string[] = []
    mockResumePending.mockImplementation(async () => (order.push('resume'), { kind: 'idle' }))
    mockLookupProfile.mockImplementation(async () => (order.push('lookup'), { kind: 'none' }))
    draw()
    await waitFor(() => expect(order).toEqual(['resume', 'lookup']))
    expect(mockLookupProfile).toHaveBeenCalledWith(OWN_KEY)
  })

  /**
   * `getHandleRegistryConfig` returns a fresh object every call, so a client
   * memoised on it would be a new client every render and this effect would
   * resume a journal and hit the network once per keystroke. Typing is the
   * cheapest way to prove the memo is keyed on the two strings instead.
   */
  it('asks once per mount, not once per render', async () => {
    withRegistry()
    const s = draw()
    await waitFor(() => expect(mockLookupProfile).toHaveBeenCalledTimes(1))
    const input = s.getByPlaceholderText('profile_handle_placeholder')
    fireEvent.changeText(input, 'd')
    fireEvent.changeText(input, 'de')
    fireEvent.changeText(input, 'dee')
    await waitFor(() => expect(s.getByText('profile_handle_available:dee@deggen.com')).toBeTruthy())
    expect(mockResumePending).toHaveBeenCalledTimes(1)
    expect(mockLookupProfile).toHaveBeenCalledTimes(1)
  })

  it('shows the cached handle at once and corrects it when the registry answers', async () => {
    withRegistry()
    kv.set('profile_registered_handle', 'old@deggen.com')
    // The lookup is held open deliberately. Both the cached read and a
    // `mockResolvedValue` lookup settle within a microtask or two of each
    // other, so without a gate this test would be asserting an intermediate
    // frame it does not control — and would usually find the corrected value
    // already on screen.
    let answer: (found: { kind: 'found'; profile: { paymail: string } }) => void = () => {}
    mockLookupProfile.mockImplementation(() => new Promise(resolve => (answer = resolve)))
    const s = draw()
    await waitFor(() => expect(s.getByText('old@deggen.com')).toBeTruthy())
    expect(s.queryByText('dee@deggen.com')).toBeNull()

    answer({ kind: 'found', profile: { paymail: 'dee@deggen.com' } })
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    expect(kv.get('profile_registered_handle')).toBe('dee@deggen.com')
  })

  it('throws away a cached value from before handles carried a domain', async () => {
    withRegistry()
    kv.set('profile_registered_handle', 'dee')
    const s = draw()
    await waitFor(() => expect(s.getByPlaceholderText('profile_handle_placeholder')).toBeTruthy())
    expect(s.queryByText('dee')).toBeNull()
  })

  it('clears the cache when the registry says we hold nothing', async () => {
    withRegistry()
    kv.set('profile_registered_handle', 'dee@deggen.com')
    const s = draw()
    await waitFor(() => expect(kv.get('profile_registered_handle')).toBe(''))
    expect(s.getByPlaceholderText('profile_handle_placeholder')).toBeTruthy()
  })

  /**
   * The cache exists for exactly this moment, so a registry that did not answer
   * must not be read as one that answered "nothing" — that is the difference
   * between `lookupProfile`'s `none` and its `failed`, and blanking the handle
   * here would leave an offline wallet unable to show or share it at all.
   */
  it('keeps the cached handle when the registry cannot be reached', async () => {
    withRegistry()
    kv.set('profile_registered_handle', 'dee@deggen.com')
    mockLookupProfile.mockResolvedValue({ kind: 'failed' })
    const s = draw()
    await waitFor(() => expect(mockLookupProfile).toHaveBeenCalledTimes(1))
    expect(s.getByText('dee@deggen.com')).toBeTruthy()
    expect(kv.get('profile_registered_handle')).toBe('dee@deggen.com')
  })

  /**
   * The cache write is the one call in this effect that can reject, and an
   * uncaught one there is an unhandled rejection on a screen whose handle is
   * already correct on screen — the same best-effort posture the display-name
   * write takes ten lines below.
   */
  it('shows the registry answer even when the cache will not take it', async () => {
    withRegistry()
    writeFailsFor = 'profile_registered_handle'
    mockLookupProfile.mockResolvedValue({
      kind: 'found',
      profile: { paymail: 'dee@deggen.com', handle: 'dee', domain: 'deggen.com' }
    })
    const unhandled: unknown[] = []
    const listener = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', listener)
    try {
      const s = draw()
      await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
      await settle()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('shows a non-blocking finishing state with a retry for a pending journal', async () => {
    withRegistry()
    mockResumePending.mockResolvedValue({ kind: 'pending' })
    const s = draw()
    await waitFor(() => expect(s.getByText('profile_handle_pending')).toBeTruthy())
    fireEvent.press(s.getByText('retry'))
    await waitFor(() => expect(mockResumePending).toHaveBeenCalledTimes(2))
  })

  /**
   * A resumed journal reaches every outcome a Claim press does, and the mount
   * is where the crash cases land: the user was last shown "finishing…", and a
   * resume that quietly rolled them back onto the old handle, or was refused
   * outright, would clear that callout and say nothing at all.
   */
  it('tells the user which handle they kept when the resumed journal rolled back', async () => {
    withRegistry()
    mockResumePending.mockResolvedValue({
      kind: 'rolled_back',
      paymail: 'dee@deggen.com',
      attempted: 'deggen@deggen.com'
    })
    mockLookupProfile.mockResolvedValue({ kind: 'found', profile: { paymail: 'dee@deggen.com' } })
    const s = draw()
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('profile_handle_rolled_back:deggen@deggen.com,dee@deggen.com', {
        type: 'error'
      })
    )
    expect(s.getByText('dee@deggen.com')).toBeTruthy()
    expect(kv.get('profile_registered_handle')).toBe('dee@deggen.com')
    expect(s.queryByText('profile_handle_pending')).toBeNull()
  })

  /**
   * A removal that wrote its release journal and was killed before the answer
   * leaves one for the next visit here. Finishing it means the handle is gone,
   * so the screen must stop offering it — from the cache too, which the lookup
   * that follows cannot be relied on to clear (it may be offline) — and must
   * not tell the user a refusal happened.
   */
  it('drops the handle, without calling it a refusal, when the resumed journal was a release', async () => {
    withRegistry()
    kv.set('profile_registered_handle', 'dee@deggen.com')
    mockResumePending.mockResolvedValue({ kind: 'released', paymail: 'dee@deggen.com' })
    mockLookupProfile.mockResolvedValue({ kind: 'failed' })
    const s = draw()
    await waitFor(() => expect(kv.get('profile_registered_handle')).toBe(''))
    await settle()
    expect(showToast).not.toHaveBeenCalled()
    expect(s.queryByText('dee@deggen.com')).toBeNull()
    expect(s.getByPlaceholderText('profile_handle_placeholder')).toBeTruthy()
  })

  it('reports a resumed journal the registry refused', async () => {
    withRegistry()
    mockResumePending.mockResolvedValue({ kind: 'rejected', code: 'ERR_HANDLE_TAKEN', description: 'taken' })
    draw()
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('profile_handle_rejected', { type: 'error' }))
    // And does not chase its own tail: the mount effect must not re-resume off
    // the refusal it just reported.
    await pastTheDebounce()
    expect(mockResumePending).toHaveBeenCalledTimes(1)
  })

  it('repeats the reason a resumed write failed', async () => {
    withRegistry()
    mockResumePending.mockResolvedValue({ kind: 'failed', message: 'boom' })
    draw()
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('boom', { type: 'error' }))
  })

  /**
   * The lookup this screen starts with is not cancelled by a claim — nothing in
   * a registration changes any of the effect's dependencies — so its answer,
   * which the registry computed before the claim landed, arrives afterwards.
   * Applying it would put the old handle back on screen AND on disk, and the
   * cache is the one value this screen cannot mint again offline.
   */
  it('does not let a slow lookup put the old handle back after a claim', async () => {
    withRegistry()
    kv.set('profile_registered_handle', 'old@deggen.com')
    let answer: (seen: { kind: 'found'; profile: { paymail: string } }) => void = () => {}
    mockLookupProfile.mockImplementation(() => new Promise(resolve => (answer = resolve)))
    mockChangeHandle.mockResolvedValue({ kind: 'changed', paymail: 'dee@deggen.com' })
    const s = draw()
    await waitFor(() => expect(s.getByText('old@deggen.com')).toBeTruthy())
    fireEvent.press(s.getByText('profile_handle_change'))
    fireEvent.changeText(s.getByPlaceholderText('profile_handle_placeholder'), 'dee')
    await waitFor(() => expect(s.getByText('profile_handle_available:dee@deggen.com')).toBeTruthy())
    fireEvent.press(s.getByText('profile_handle_claim:dee@deggen.com'))
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    expect(kv.get('profile_registered_handle')).toBe('dee@deggen.com')

    answer({ kind: 'found', profile: { paymail: 'old@deggen.com' } })
    await settle()
    expect(s.getByText('dee@deggen.com')).toBeTruthy()
    expect(s.queryByText('old@deggen.com')).toBeNull()
    expect(kv.get('profile_registered_handle')).toBe('dee@deggen.com')
  })
})

describe('claiming', () => {
  /** A first claim of `dee`, up to and including the button press. */
  const claim = async () => {
    const s = draw()
    fireEvent.changeText(await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder')), 'dee')
    await waitFor(() => expect(s.getByText('profile_handle_available:dee@deggen.com')).toBeTruthy())
    fireEvent.press(s.getByText('profile_handle_claim:dee@deggen.com'))
    return s
  }

  it('registers a first handle and keeps the full paymail', async () => {
    withRegistry()
    mockRegisterHandle.mockResolvedValue({ kind: 'registered', paymail: 'dee@deggen.com' })
    const s = draw()
    fireEvent.changeText(await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder')), 'dee')
    await waitFor(() => expect(s.getByText('profile_handle_available:dee@deggen.com')).toBeTruthy())
    fireEvent.press(s.getByText('profile_handle_claim:dee@deggen.com'))
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    expect(mockRegisterHandle).toHaveBeenCalledWith(expect.anything(), { handle: 'dee', displayName: '' })
    expect(kv.get('profile_registered_handle')).toBe('dee@deggen.com')
    expect(showToast).toHaveBeenCalledWith('profile_handle_registered', { type: 'success' })
  })

  it('changes an existing handle rather than claiming a second one', async () => {
    withRegistry()
    mockLookupProfile.mockResolvedValue({
      kind: 'found',
      profile: { paymail: 'dee@deggen.com', handle: 'dee', domain: 'deggen.com' }
    })
    mockChangeHandle.mockResolvedValue({ kind: 'changed', paymail: 'deggen@deggen.com' })
    const s = draw()
    fireEvent.press(await waitFor(() => s.getByText('profile_handle_change')))
    fireEvent.changeText(s.getByPlaceholderText('profile_handle_placeholder'), 'deggen')
    await waitFor(() => expect(s.getByText('profile_handle_available:deggen@deggen.com')).toBeTruthy())
    fireEvent.press(s.getByText('profile_handle_claim:deggen@deggen.com'))
    await waitFor(() =>
      expect(mockChangeHandle).toHaveBeenCalledWith(expect.anything(), {
        previousPaymail: 'dee@deggen.com',
        handle: 'deggen',
        displayName: ''
      })
    )
    expect(kv.get('profile_registered_handle')).toBe('deggen@deggen.com')
  })

  it('tells the user which handle they kept after a rollback', async () => {
    withRegistry()
    mockLookupProfile.mockResolvedValue({
      kind: 'found',
      profile: { paymail: 'dee@deggen.com', handle: 'dee', domain: 'deggen.com' }
    })
    mockChangeHandle.mockResolvedValue({ kind: 'rolled_back', paymail: 'dee@deggen.com' })
    const s = draw()
    fireEvent.press(await waitFor(() => s.getByText('profile_handle_change')))
    fireEvent.changeText(s.getByPlaceholderText('profile_handle_placeholder'), 'deggen')
    await waitFor(() => expect(s.getByText('profile_handle_available:deggen@deggen.com')).toBeTruthy())
    fireEvent.press(s.getByText('profile_handle_claim:deggen@deggen.com'))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('profile_handle_rolled_back:deggen@deggen.com,dee@deggen.com', {
        type: 'error'
      })
    )
    expect(kv.get('profile_registered_handle')).toBe('dee@deggen.com')
  })

  it('reports a refusal without pretending the claim worked', async () => {
    withRegistry()
    mockRegisterHandle.mockResolvedValue({ kind: 'rejected', code: 'ERR_HANDLE_TAKEN', description: 'taken' })
    const s = draw()
    fireEvent.changeText(await waitFor(() => s.getByPlaceholderText('profile_handle_placeholder')), 'dee')
    await waitFor(() => expect(s.getByText('profile_handle_available:dee@deggen.com')).toBeTruthy())
    fireEvent.press(s.getByText('profile_handle_claim:dee@deggen.com'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('profile_handle_rejected', { type: 'error' }))
    expect(kv.get('profile_registered_handle')).toBeUndefined()
  })

  it('hands a journalled claim to the finishing state instead of a toast', async () => {
    withRegistry()
    mockRegisterHandle.mockResolvedValue({ kind: 'pending' })
    const s = await claim()
    await waitFor(() => expect(s.getByText('profile_handle_pending')).toBeTruthy())
    expect(showToast).not.toHaveBeenCalled()
    expect(kv.get('profile_registered_handle')).toBeUndefined()
  })

  /**
   * A journalled write holds the only copy of a signed, replayable certificate.
   * A second press would ask for a second intent over it — and a `release` is
   * idempotent only while the identical bytes are replayed, so the fresh one
   * finds nothing to release while the claim that could still have finished is
   * overwritten. The callout's own Retry is the way out of this state.
   */
  it('will not take a second Claim press while a journalled write is outstanding', async () => {
    withRegistry()
    mockRegisterHandle.mockResolvedValue({ kind: 'pending' })
    const s = await claim()
    await waitFor(() => expect(s.getByText('profile_handle_pending')).toBeTruthy())
    expect(claimDisabled(s, 'profile_handle_claim:dee@deggen.com')).toBe(true)
    fireEvent.press(s.getByText('profile_handle_claim:dee@deggen.com'))
    await pastTheDebounce()
    expect(mockRegisterHandle).toHaveBeenCalledTimes(1)
  })

  /**
   * `bindOriginator` is what makes signing the user's own profile silent, and
   * the module it is handed to only ever calls the signer through the SDK —
   * which passes one argument. Driving the real certificate builder through the
   * signer this screen supplied is the only way to see that binding at all.
   */
  it('hands the registration module a signer bound to the admin originator', async () => {
    withRegistry()
    mockRegisterHandle.mockResolvedValue({ kind: 'registered', paymail: 'dee@deggen.com' })
    await claim()
    await waitFor(() => expect(mockRegisterHandle).toHaveBeenCalled())
    const { signer } = mockRegisterHandle.mock.calls[0][0] as { signer: ProfileSigner }
    const cert = await buildProfileCertificate({ signer, paymail: 'dee@deggen.com', issuedAt: new Date() })
    expect(cert.signature).not.toBe('')
    // `createSignature` is never called by the screen itself, so this call can
    // only have come through the signer it handed over.
    expect(mockPermissionsManager.createSignature).toHaveBeenCalledWith(expect.anything(), 'admin.com')
  })

  it('says a registry it could not reach is not available', async () => {
    withRegistry()
    mockRegisterHandle.mockResolvedValue({ kind: 'unavailable' })
    const s = await claim()
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('profile_handle_unavailable', { type: 'error' }))
    expect(s.getByText('profile_handle_claim:dee@deggen.com')).toBeTruthy()
  })

  it('repeats the reason a write failed', async () => {
    withRegistry()
    mockRegisterHandle.mockResolvedValue({ kind: 'failed', message: 'boom' })
    await claim()
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('boom', { type: 'error' }))
  })

  /**
   * `updated` and `idle` cannot reach a Claim press today, and that is exactly
   * why the final `else` is worth pinning: without it a result kind nobody
   * anticipated leaves the button spinning and says nothing at all.
   */
  it('never leaves the button spinning on a result kind it did not expect', async () => {
    withRegistry()
    mockRegisterHandle.mockResolvedValue({ kind: 'updated', paymail: 'dee@deggen.com' })
    const s = await claim()
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('profile_handle_rejected', { type: 'error' }))
    expect(s.getByText('profile_handle_claim:dee@deggen.com')).toBeTruthy()
    expect(kv.get('profile_registered_handle')).toBeUndefined()
  })
})

describe('the display name', () => {
  it('is saved locally and, when a handle is registered, published to the registry', async () => {
    withRegistry()
    mockLookupProfile.mockResolvedValue({
      kind: 'found',
      profile: { paymail: 'dee@deggen.com', handle: 'dee', domain: 'deggen.com' }
    })
    mockUpdateProfile.mockResolvedValue({ kind: 'updated', paymail: 'dee@deggen.com' })
    const s = draw()
    // The registered handle is the precondition under test, and it arrives with
    // the reverse lookup — saving before it lands is the "no handle registered"
    // case, which the next test covers.
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    fireEvent.press(await waitFor(() => s.getByLabelText('contact_edit_name')))
    fireEvent.changeText(s.getByPlaceholderText('profile_display_name'), '  Dee K  ')
    fireEvent.press(s.getByLabelText('contact_save_name'))
    await waitFor(() => expect(kv.get('profile_display_name')).toBe('Dee K'))
    await waitFor(() =>
      expect(mockUpdateProfile).toHaveBeenCalledWith(expect.anything(), {
        paymail: 'dee@deggen.com',
        displayName: 'Dee K'
      })
    )
  })

  it('stays purely local while no handle is registered', async () => {
    withRegistry()
    const s = draw()
    fireEvent.press(await waitFor(() => s.getByLabelText('contact_edit_name')))
    fireEvent.changeText(s.getByPlaceholderText('profile_display_name'), 'Dee K')
    fireEvent.press(s.getByLabelText('contact_save_name'))
    await waitFor(() => expect(kv.get('profile_display_name')).toBe('Dee K'))
    expect(mockUpdateProfile).not.toHaveBeenCalled()
  })

  /**
   * The hint under this field promises the name is public. A publish the
   * registry refused leaves it serving the previous one, and saying nothing
   * would make that promise false with no way for the user to find out.
   */
  it.each([
    [{ kind: 'rejected', code: 'ERR_INVALID_CERTIFICATE', description: 'no' }],
    [{ kind: 'failed', message: 'stale' }]
  ])('says so when the registry would not publish the name (%p)', async (result: Record<string, unknown>) => {
    withRegistry()
    mockLookupProfile.mockResolvedValue({
      kind: 'found',
      profile: { paymail: 'dee@deggen.com', handle: 'dee', domain: 'deggen.com' }
    })
    mockUpdateProfile.mockResolvedValue(result)
    const s = draw()
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    fireEvent.press(s.getByLabelText('contact_edit_name'))
    fireEvent.changeText(s.getByPlaceholderText('profile_display_name'), 'Dee K')
    fireEvent.press(s.getByLabelText('contact_save_name'))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('profile_display_name_publish_failed', { type: 'error' })
    )
    // Local first, always: the name is this device's to show either way.
    expect(kv.get('profile_display_name')).toBe('Dee K')
  })

  /**
   * `updateProfile` refuses to displace an unfinished journal — it finishes it
   * instead — so a save made while one is outstanding would answer with the
   * other write's outcome. Nothing is asked of the registry until the callout's
   * Retry has cleared it.
   */
  it('keeps the name local while a journalled write is still outstanding', async () => {
    withRegistry()
    mockResumePending.mockResolvedValue({ kind: 'pending' })
    mockLookupProfile.mockResolvedValue({
      kind: 'found',
      profile: { paymail: 'dee@deggen.com', handle: 'dee', domain: 'deggen.com' }
    })
    const s = draw()
    await waitFor(() => expect(s.getByText('profile_handle_pending')).toBeTruthy())
    fireEvent.press(s.getByLabelText('contact_edit_name'))
    fireEvent.changeText(s.getByPlaceholderText('profile_display_name'), 'Dee K')
    fireEvent.press(s.getByLabelText('contact_save_name'))
    await waitFor(() => expect(kv.get('profile_display_name')).toBe('Dee K'))
    expect(mockUpdateProfile).not.toHaveBeenCalled()
  })

  it('says the name is public', async () => {
    withRegistry()
    const s = draw()
    await waitFor(() => expect(s.getByText('profile_display_name_hint')).toBeTruthy())
  })
})

describe('the profile name', () => {
  /** Profiles 0 and 1, the second one active — the profile this screen is about. */
  const onProfileOne = async () => {
    mockProfilesSupported = true
    await appendProfile('main')
    await setActiveProfile(1)
  }

  it('is not offered on a wallet without profiles', async () => {
    const s = draw()
    await waitFor(() => expect(s.getByText('profile_display_name_hint')).toBeTruthy())
    // Section headers are drawn in capitals.
    expect(s.queryByText('PROFILE_NAME')).toBeNull()
    expect(s.queryByLabelText('profile_name_edit')).toBeNull()
  })

  it('says it is private to this device, apart from the public display name', async () => {
    await onProfileOne()
    const s = draw()
    expect(s.getByText('PROFILE_NAME')).toBeTruthy()
    expect(s.getByText('profile_name_hint')).toBeTruthy()
    expect(s.getByText('profile_display_name_hint')).toBeTruthy()
  })

  it('is saved to the active profile, trimmed, and to no other', async () => {
    await onProfileOne()
    const s = draw()
    fireEvent.press(s.getByLabelText('profile_name_edit'))
    // The default label stands in until a name is given.
    fireEvent.changeText(s.getByPlaceholderText('profile_label:2'), '  Savings  ')
    fireEvent.press(s.getByLabelText('profile_name_save'))
    await waitFor(() => expect(getProfilesState().profiles[1].name).toBe('Savings'))
    expect(getProfilesState().profiles[0].name).toBeUndefined()
  })

  it('stays on this device: nothing is asked of the registry or the database', async () => {
    withRegistry()
    mockLookupProfile.mockResolvedValue({
      kind: 'found',
      profile: { paymail: 'dee@deggen.com', handle: 'dee', domain: 'deggen.com' }
    })
    await onProfileOne()
    const s = draw()
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    fireEvent.press(s.getByLabelText('profile_name_edit'))
    fireEvent.changeText(s.getByPlaceholderText('profile_label:2'), 'Savings')
    fireEvent.press(s.getByLabelText('profile_name_save'))
    await waitFor(() => expect(getProfilesState().profiles[1].name).toBe('Savings'))
    expect(mockUpdateProfile).not.toHaveBeenCalled()
    expect(kv.get('profile_display_name')).toBeUndefined()
  })

  it('shows the name the profile already has, and clearing it goes back to the default', async () => {
    await onProfileOne()
    await updateProfileRecord(1, { name: 'Savings' })
    const s = draw()
    const field = s.getByDisplayValue('Savings')
    fireEvent.changeText(field, '')
    fireEvent.press(s.getByLabelText('profile_name_save'))
    await waitFor(() => expect(getProfilesState().profiles[1].name).toBeUndefined())
    expect(s.getByPlaceholderText('profile_label:2')).toBeTruthy()
  })

  it('stops at the length the store keeps', async () => {
    await onProfileOne()
    const s = draw()
    expect(s.getByPlaceholderText('profile_label:2').props.maxLength).toBe(MAX_PROFILE_NAME_LENGTH)
  })

  it('names the active profile, not profile 0', async () => {
    mockProfilesSupported = true
    const s = draw()
    expect(s.getByPlaceholderText('profile_label:1')).toBeTruthy()
  })
})

describe('removing the profile', () => {
  const onProfileOne = async () => {
    mockProfilesSupported = true
    await appendProfile('main')
    await setActiveProfile(1)
  }
  /** What the Remove row's dialogs said, in order. */
  const alerts = () =>
    mockShowAlert.mock.calls.map(c => c[0] as { title: string; message: string; buttons: { key: string }[] })
  const tapRemove = (s: ReturnType<typeof draw>) => fireEvent.press(s.getByText('profile_remove'))
  const TITLE = 'profile_remove_problem_title:profile_label:2'

  beforeEach(() => {
    mockCheckProfileRemoval.mockResolvedValue({ kind: 'ok', handle: null })
    mockRemoveProfile.mockResolvedValue({ kind: 'removed', index: 1 })
    mockShowAlert.mockResolvedValue('remove')
  })

  it('is not offered on profile 0, nor on a wallet without profiles', async () => {
    mockProfilesSupported = true
    expect(draw().queryByText('profile_remove')).toBeNull()
    mockProfilesSupported = false
    __resetProfilesForTests()
    await appendProfile('main')
    await setActiveProfile(1)
    expect(draw().queryByText('profile_remove')).toBeNull()
  })

  it('is a destructive row on any other profile, saying it has to be empty first', async () => {
    await onProfileOne()
    const s = draw()
    expect(s.getByText('profile_remove')).toBeTruthy()
    expect(s.getByText('profile_remove_hint')).toBeTruthy()
    expect(mockCheckProfileRemoval).not.toHaveBeenCalled()
  })

  it('checks first and, when the profile holds money, says so and asks for nothing', async () => {
    await onProfileOne()
    mockCheckProfileRemoval.mockResolvedValue({ kind: 'blocked', reasons: ['spendable-outputs'] })
    mockShowAlert.mockResolvedValue('ok')
    const s = draw()
    tapRemove(s)
    await waitFor(() => expect(mockShowAlert).toHaveBeenCalledTimes(1))
    expect(alerts()[0]).toMatchObject({ title: TITLE, message: 'profile_remove_blocked_funds' })
    expect(mockRemoveProfile).not.toHaveBeenCalled()
  })

  it.each<[string, object, string]>([
    [
      'pending activity',
      { kind: 'blocked', reasons: ['pending-transactions', 'inbox-pending'] },
      'profile_remove_blocked_pending'
    ],
    ['tokens', { kind: 'blocked', reasons: ['token-balance'] }, 'profile_remove_blocked_funds'],
    ['an unfinished handle write', { kind: 'blocked', reasons: ['handle-journal'] }, 'profile_remove_failed_handle'],
    ['a check that could not run', { kind: 'blocked', reasons: ['check-failed'] }, 'profile_remove_blocked_check'],
    ['a registry that did not answer', { kind: 'handle-failed' }, 'profile_remove_failed_handle'],
    ['being offline', { kind: 'refused', reason: 'offline' }, 'profile_remove_offline'],
    ['a refusal of another kind', { kind: 'refused', reason: 'busy' }, 'profile_remove_failed'],
    ['a failure', { kind: 'failed', message: 'x' }, 'profile_remove_failed']
  ])('explains %s', async (_name, check, expected) => {
    await onProfileOne()
    mockCheckProfileRemoval.mockResolvedValue(check)
    mockShowAlert.mockResolvedValue('ok')
    const s = draw()
    tapRemove(s)
    await waitFor(() => expect(mockShowAlert).toHaveBeenCalledTimes(1))
    expect(alerts()[0].message).toBe(expected)
    expect(mockRemoveProfile).not.toHaveBeenCalled()
  })

  it('tells the user about every kind of reason it found, one paragraph each', async () => {
    await onProfileOne()
    mockCheckProfileRemoval.mockResolvedValue({
      kind: 'blocked',
      reasons: ['spendable-outputs', 'offline-queue', 'check-failed']
    })
    mockShowAlert.mockResolvedValue('ok')
    const s = draw()
    tapRemove(s)
    await waitFor(() => expect(mockShowAlert).toHaveBeenCalledTimes(1))
    expect(alerts()[0].message).toBe(
      'profile_remove_blocked_funds\n\nprofile_remove_blocked_pending\n\nprofile_remove_blocked_check'
    )
  })

  it('confirms before anything is removed, naming the profile and leaving the handle out when there is none', async () => {
    await onProfileOne()
    mockShowAlert.mockResolvedValue('cancel')
    const s = draw()
    tapRemove(s)
    await waitFor(() => expect(mockShowAlert).toHaveBeenCalledTimes(1))
    const confirm = alerts()[0]
    expect(confirm.title).toBe('profile_remove_confirm_title:profile_label:2')
    expect(confirm.message).toBe('profile_remove_confirm_body:profile_label:2')
    expect(confirm.buttons.map(b => b.key)).toEqual(['cancel', 'remove'])
    await settle()
    // Cancelling is the whole of it.
    expect(mockRemoveProfile).not.toHaveBeenCalled()
    expect(router.dismissAll).not.toHaveBeenCalled()
  })

  it('uses the private name, and warns about the cooldown when a handle will be released', async () => {
    await onProfileOne()
    await updateProfileRecord(1, { name: 'Savings' })
    mockCheckProfileRemoval.mockResolvedValue({ kind: 'ok', handle: 'dee@deggen.com' })
    mockShowAlert.mockResolvedValue('cancel')
    const s = draw()
    tapRemove(s)
    await waitFor(() => expect(mockShowAlert).toHaveBeenCalledTimes(1))
    const confirm = alerts()[0]
    expect(confirm.title).toBe('profile_remove_confirm_title:Savings')
    expect(confirm.message).toBe('profile_remove_confirm_body:Savings\n\nprofile_remove_confirm_handle:dee@deggen.com')
  })

  it('removes on confirm, says so, and leaves for Home the way Delete Wallet does', async () => {
    await onProfileOne()
    const s = draw()
    tapRemove(s)
    await waitFor(() => expect(mockRemoveProfile).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'))
    expect(router.dismissAll).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('profile_removed:profile_label:2', { type: 'success' })
    // The check ran first.
    expect(mockCheckProfileRemoval.mock.invocationCallOrder[0]).toBeLessThan(
      mockRemoveProfile.mock.invocationCallOrder[0]
    )
  })

  it('stays put and explains when the removal itself is refused after the confirm', async () => {
    await onProfileOne()
    // Money arrived while the dialog was open.
    mockRemoveProfile.mockResolvedValue({ kind: 'blocked', reasons: ['spendable-outputs'] })
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValue('ok')
    const s = draw()
    tapRemove(s)
    await waitFor(() => expect(mockShowAlert).toHaveBeenCalledTimes(2))
    expect(alerts()[1]).toMatchObject({ title: TITLE, message: 'profile_remove_blocked_funds' })
    expect(router.dismissAll).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining('profile_removed'), expect.anything())
  })

  it.each<[string, object, string]>([
    ['a handle that would not release', { kind: 'handle-failed' }, 'profile_remove_failed_handle'],
    ['a switch that did not land', { kind: 'switch-failed' }, 'profile_remove_failed']
  ])('explains %s', async (_name, result, expected) => {
    await onProfileOne()
    mockRemoveProfile.mockResolvedValue(result)
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValue('ok')
    const s = draw()
    tapRemove(s)
    await waitFor(() => expect(mockShowAlert).toHaveBeenCalledTimes(2))
    expect(alerts()[1].message).toBe(expected)
    expect(router.dismissAll).not.toHaveBeenCalled()
  })

  it('explains, rather than leaving an unhandled rejection, when the plumbing around the flow throws', async () => {
    await onProfileOne()
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockRemoveProfile.mockRejectedValue(new Error('boom'))
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValue('ok')
    const s = draw()
    tapRemove(s)
    await waitFor(() => expect(mockShowAlert).toHaveBeenCalledTimes(2))
    expect(alerts()[1].message).toBe('profile_remove_failed')
    expect(router.dismissAll).not.toHaveBeenCalled()
  })

  it('asks the registry again after an attempt that did not go through, since it may have released the handle', async () => {
    withRegistry()
    await onProfileOne()
    mockRemoveProfile.mockResolvedValue({ kind: 'switch-failed' })
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValue('ok')
    const s = draw()
    await waitFor(() => expect(mockResumePending).toHaveBeenCalledTimes(1))
    tapRemove(s)
    await waitFor(() => expect(mockResumePending).toHaveBeenCalledTimes(2))
  })

  it('ignores a second tap while the first is still working', async () => {
    await onProfileOne()
    let finish: (v: object) => void = () => {}
    mockCheckProfileRemoval.mockImplementation(() => new Promise(resolve => (finish = resolve)))
    mockShowAlert.mockResolvedValue('cancel')
    const s = draw()
    tapRemove(s)
    tapRemove(s)
    await act(async () => {})
    expect(mockCheckProfileRemoval).toHaveBeenCalledTimes(1)
    await act(async () => finish({ kind: 'ok', handle: null }))
    await waitFor(() => expect(mockShowAlert).toHaveBeenCalledTimes(1))
  })

  it('keeps the row on screen when the active profile flips to 0 mid-removal, which is the removal working', async () => {
    await onProfileOne()
    let finish: (v: object) => void = () => {}
    mockRemoveProfile.mockImplementation(() => new Promise(resolve => (finish = resolve)))
    const s = draw()
    tapRemove(s)
    await waitFor(() => expect(mockRemoveProfile).toHaveBeenCalledTimes(1))
    await act(async () => {
      await setActiveProfile(0)
    })
    expect(s.getByText('profile_remove')).toBeTruthy()
    await act(async () => finish({ kind: 'removed', index: 1 }))
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'))
  })
})
