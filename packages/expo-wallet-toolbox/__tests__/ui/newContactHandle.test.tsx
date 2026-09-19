/**
 * What `/contact/add` does with the `handle` param: it is the only production
 * writer of `cachedHandle`, and the route is deep-linkable, so the param is
 * untrusted input — it has to survive `parsePaymail` AND be confirmed by the
 * registry as belonging to the identity key it arrived with before anything is
 * stored under a shield reading "only they can change it".
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
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))

let mockRouteParams: Record<string, string> = {}
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => mockRouteParams
}))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))
jest.mock('../../core/contacts/contactActivity', () => ({ getContactActivity: async () => [] }))

const mockCreateContact = jest.fn()
jest.mock('../../ui/hooks/useContactsStore', () => ({
  useContactsStore: () => ({ createContact: mockCreateContact })
}))
const mockLookupProfile = jest.fn()
jest.mock('../../core/identity/handleRegistry/client', () => ({
  createHandleRegistryClient: () => ({ domain: 'deggen.com', lookupProfile: mockLookupProfile })
}))
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({
    walletUserId: 1,
    managers: null,
    adminOriginator: 'admin.com',
    storage: undefined,
    selectedNetwork: 'test'
  })
}))

import React from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { ThemeProvider, configureToolbox, resetToolboxConfig } from '@bsv/expo-wallet-toolbox'
import { NewContactScreen } from '../../ui/screens/NewContactScreen'

const KEY = '02' + 'ab'.repeat(32)
const ATTACKER_KEY = '03' + 'ba'.repeat(32)
const draw = () =>
  render(
    <ThemeProvider>
      <NewContactScreen />
    </ThemeProvider>
  )

const withRegistry = () =>
  configureToolbox({
    backupUrl: null,
    handleRegistry: { test: { domain: 'deggen.com', url: 'https://registry.example' } }
  })

/** Two turns, so a lookup that was going to answer has answered. */
const settle = () =>
  act(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })

const savedWithNoHandle = async () =>
  await waitFor(() =>
    expect(mockCreateContact).toHaveBeenCalledWith(expect.not.objectContaining({ cachedHandle: expect.anything() }))
  )

beforeEach(() => {
  jest.clearAllMocks()
  resetToolboxConfig()
  mockCreateContact.mockResolvedValue({})
  mockRouteParams = {}
  mockLookupProfile.mockResolvedValue({ kind: 'none' })
})
afterEach(() => resetToolboxConfig())

describe('a contact saved from a registry hit', () => {
  it('stores the handle once the registry confirms this key holds it', async () => {
    withRegistry()
    mockRouteParams = { identityKey: KEY, name: 'Dee K', handle: 'Dee@Deggen.com', source: 'pay' }
    mockLookupProfile.mockResolvedValue({ kind: 'found', profile: { paymail: 'dee@deggen.com' } })
    const s = draw()
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    expect(mockLookupProfile).toHaveBeenCalledWith(KEY, 'deggen.com')
    fireEvent.changeText(s.getByPlaceholderText('contact_new_title'), 'Dee from the pub')
    fireEvent.press(s.getByText('contact_save'))
    await waitFor(() =>
      expect(mockCreateContact).toHaveBeenCalledWith({
        userId: 1,
        identityKey: KEY,
        name: 'Dee from the pub',
        cachedHandle: 'dee@deggen.com',
        source: 'pay'
      })
    )
  })

  it('saves no handle when none arrived, and says so', async () => {
    withRegistry()
    mockRouteParams = { identityKey: KEY, name: 'Dee K', source: 'qr' }
    const s = draw()
    expect(s.getByText('contact_no_handle_registered')).toBeTruthy()
    expect(mockLookupProfile).not.toHaveBeenCalled()
    fireEvent.press(s.getByText('contact_save'))
    await savedWithNoHandle()
  })

  /**
   * `/contact/add` is deep-linkable, so this param is untrusted input, and
   * what it becomes is shown under a shield and the words "only they can
   * change it". A string that is not a paymail is not a handle.
   */
  it.each(['not-a-paymail', 'dee@', '@deggen.com', 'Dee <script>@deggen.com', 'a@b@c'])(
    'refuses %s as a handle rather than displaying it as a verified one',
    async (raw: string) => {
      withRegistry()
      mockRouteParams = { identityKey: KEY, name: 'Dee K', handle: raw, source: 'pay' }
      const s = draw()
      expect(s.getByText('contact_no_handle_registered')).toBeTruthy()
      expect(s.queryByText(raw)).toBeNull()
      fireEvent.press(s.getByText('contact_save'))
      await savedWithNoHandle()
    }
  )

  /**
   * Shape is not proof. `bsv-wallet://contact/add?identityKey=<attacker>&handle=dee@deggen.com`
   * is a link a phishing page can hand over, and every part of it is the
   * attacker's: a well-formed paymail asserted for a key that does not hold it.
   * Stored, it would draw the victim's address under a shield against the
   * attacker's key, and put that row at the top of Pay's picker for the
   * genuine address typed in full.
   */
  it('refuses a well-formed handle the registry does not give this key', async () => {
    withRegistry()
    mockRouteParams = { identityKey: ATTACKER_KEY, name: 'Dee', handle: 'dee@deggen.com', source: 'pay' }
    mockLookupProfile.mockResolvedValue({ kind: 'found', profile: { paymail: 'dee1@deggen.com' } })
    const s = draw()
    await settle()
    expect(s.queryByText('dee@deggen.com')).toBeNull()
    expect(s.getByText('contact_no_handle_registered')).toBeTruthy()
    fireEvent.press(s.getByText('contact_save'))
    await savedWithNoHandle()
  })

  it('refuses one the registry says this key holds nothing for', async () => {
    withRegistry()
    mockRouteParams = { identityKey: ATTACKER_KEY, name: 'Dee', handle: 'dee@deggen.com', source: 'pay' }
    mockLookupProfile.mockResolvedValue({ kind: 'none' })
    const s = draw()
    await settle()
    expect(s.queryByText('dee@deggen.com')).toBeNull()
    fireEvent.press(s.getByText('contact_save'))
    await savedWithNoHandle()
  })

  /**
   * Fail closed, both ways a check can be impossible. A production build
   * configures no registry at all, and ContactScreen's background refresh is
   * inert there too — so a handle written now would never be corrected. An
   * offline check is the same fact for the length of this screen, and that
   * refresh fills the column in on the next visit.
   */
  it('stores nothing it could not check, offline or with no registry on this chain', async () => {
    withRegistry()
    mockRouteParams = { identityKey: KEY, name: 'Dee K', handle: 'dee@deggen.com', source: 'pay' }
    mockLookupProfile.mockResolvedValue({ kind: 'failed' })
    const offline = draw()
    await settle()
    expect(offline.queryByText('dee@deggen.com')).toBeNull()
    fireEvent.press(offline.getByText('contact_save'))
    await savedWithNoHandle()

    mockCreateContact.mockClear()
    resetToolboxConfig()
    mockLookupProfile.mockResolvedValue({ kind: 'found', profile: { paymail: 'dee@deggen.com' } })
    const unconfigured = draw()
    await settle()
    expect(unconfigured.queryByText('dee@deggen.com')).toBeNull()
    fireEvent.press(unconfigured.getByText('contact_save'))
    await savedWithNoHandle()
  })
})
