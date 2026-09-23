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
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({})
}))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))
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
    selectedNetwork: mockNetwork
  })
}))

import React from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { ThemeProvider, configureToolbox, resetToolboxConfig } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../../ui/components/ui/Toast'
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
