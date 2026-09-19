/**
 * ContactScreen's background cache refresh — the riskiest edit in this feature.
 * It does two lookups in parallel, merges them into ONE write (because
 * `refreshContactCache` replaces all three cache columns), routes the reverse
 * lookup by the cached handle's own domain, and is guarded against the loop its
 * own `reload()` would otherwise create.
 *
 * The case that matters most is the offline one: a lookup that could not be
 * made must leave the cached handle exactly where it was.
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
jest.mock('react-native-qrcode-svg', () => 'QRCode')
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
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: jest.fn() }))
jest.mock('../../core/contacts/contactActivity', () => ({ getContactActivity: async () => [] }))

const mockResolveIdentity = jest.fn()
jest.mock('../../ui/resolveIdentity', () => ({
  // The real one answers null without a wallet, which is exactly what a screen
  // drawn before the wallet finished building is handed.
  makeIdentityClient: (wallet: unknown) => (wallet ? {} : null),
  resolveIdentity: (...a: unknown[]) => mockResolveIdentity(...a)
}))

const mockLookupProfile = jest.fn()
jest.mock('../../core/identity/handleRegistry/client', () => ({
  createHandleRegistryClient: () => ({ domain: 'deggen.com', lookupProfile: mockLookupProfile })
}))

type Contact = { identityKey: string; name: string; cachedHandle?: string; cachedAvatarUrl?: string }
let mockStored: Contact
let mockRows: Contact[]
const mockRefreshContactCache = jest.fn()
const mockRenameContact = jest.fn()
// One store object for the whole render tree, the way `useContactsStore`
// memoises the real one: a fresh one per render would make every write look
// like a new store and re-run the effects keyed off it.
const mockStore = {
  getContact: async () => mockStored,
  searchContacts: async () => mockRows,
  refreshContactCache: (...a: unknown[]) => {
    // The real store writes the row and the screen reloads from it.
    const cache = a[2] as Partial<Contact>
    mockStored = { ...mockStored, ...cache }
    return mockRefreshContactCache(...a)
  },
  renameContact: (...a: unknown[]) => {
    // Also a real write, so the reload it triggers yields a different row —
    // which is what makes a rename a mid-flight `contact` change.
    mockStored = { ...mockStored, name: a[2] as string }
    return mockRenameContact(...a)
  },
  deleteContact: jest.fn()
}
jest.mock('../../ui/hooks/useContactsStore', () => ({ useContactsStore: () => mockStore }))
// Likewise one wallet object: the real `useWallet` hands out a context value,
// and `managers` is an effect dependency on both screens here. `managers` is
// reassigned by the case that draws before the wallet is built.
const mockWallet = {
  managers: {} as { permissionsManager?: object },
  adminOriginator: 'admin.com',
  storage: undefined,
  walletUserId: 1,
  selectedNetwork: 'test'
}
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => mockWallet
}))

import React from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react-native'
import { ThemeProvider, configureToolbox, resetToolboxConfig } from '@bsv/expo-wallet-toolbox'
import { ContactScreen } from '../../ui/screens/ContactScreen'
import { ContactsScreen } from '../../ui/screens/ContactsScreen'
import { IdentifierScreen } from '../../ui/screens/IdentifierScreen'

const KEY = '02' + 'ab'.repeat(32)
const OTHER_KEY = '03' + 'cd'.repeat(32)
const draw = () =>
  render(
    <ThemeProvider>
      <ContactScreen />
    </ThemeProvider>
  )

const withRegistry = () =>
  configureToolbox({
    backupUrl: null,
    handleRegistry: { test: { domain: 'deggen.com', url: 'https://registry.example' } }
  })

beforeEach(() => {
  jest.clearAllMocks()
  resetToolboxConfig()
  mockRouteParams = { identityKey: KEY }
  mockWallet.managers = { permissionsManager: {} }
  mockStored = { identityKey: KEY, name: 'Dee from the pub', cachedHandle: 'dee@deggen.com' }
  mockRows = []
  mockResolveIdentity.mockResolvedValue([true, { avatarURL: '' }])
  mockLookupProfile.mockResolvedValue({ kind: 'none' })
  // Set here rather than left bare, so one case's rejection cannot leak into
  // the next through `clearAllMocks` (which clears calls, not implementations).
  mockRefreshContactCache.mockResolvedValue(undefined)
  mockRenameContact.mockResolvedValue(undefined)
})
afterEach(() => resetToolboxConfig())

describe('the hero', () => {
  it('shows the cached handle with no sigil in front of it', async () => {
    withRegistry()
    mockLookupProfile.mockResolvedValue({ kind: 'found', profile: { paymail: 'dee@deggen.com' } })
    const s = draw()
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    expect(s.queryByText('@dee@deggen.com')).toBeNull()
    expect(s.getByText('contact_handle_caption')).toBeTruthy()
  })
})

describe('the background refresh', () => {
  it('writes the handle and the avatar together, in one call, once per visit', async () => {
    withRegistry()
    mockResolveIdentity.mockResolvedValue([true, { avatarURL: 'https://a/x.png' }])
    mockLookupProfile.mockResolvedValue({ kind: 'found', profile: { paymail: 'deggen@deggen.com' } })
    draw()
    await waitFor(() => expect(mockRefreshContactCache).toHaveBeenCalledTimes(1))
    expect(mockRefreshContactCache).toHaveBeenCalledWith(1, KEY, {
      cachedHandle: 'deggen@deggen.com',
      cachedAvatarUrl: 'https://a/x.png',
      cachedCertifier: undefined
    })
    // The write feeds `reload()`, which produces a new `contact` — the effect
    // must not run again on it. The write count alone cannot see that: the row
    // now holds what was looked up, so a second pass would merge to null and
    // write nothing anyway. What the guard stops is a second round of network
    // lookups per reload, so that is what this pins.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mockRefreshContactCache).toHaveBeenCalledTimes(1)
    expect(mockLookupProfile).toHaveBeenCalledTimes(1)
    expect(mockResolveIdentity).toHaveBeenCalledTimes(1)
  })

  /**
   * WalletContext publishes `storage` and `walletUserId` long before `managers`
   * (the build attaches storage, reads auth, migrates baskets and lists outputs
   * first), and no route waits for the wallet to be built. A contact opened in
   * that window has no identity client — and, in a build that configures no
   * registry for its chain, no registry client either — so the pass can do
   * nothing at all. It must not spend the visit's one attempt: `managers` is an
   * effect dependency precisely so the refresh happens when they arrive.
   */
  it('still refreshes when the wallet finishes building after the screen is drawn', async () => {
    mockWallet.managers = {}
    mockResolveIdentity.mockResolvedValue([true, { avatarURL: 'https://a/x.png' }])
    const s = draw()
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mockRefreshContactCache).not.toHaveBeenCalled()
    mockWallet.managers = { permissionsManager: {} }
    s.rerender(
      <ThemeProvider>
        <ContactScreen />
      </ThemeProvider>
    )
    await waitFor(() => expect(mockRefreshContactCache).toHaveBeenCalledTimes(1))
    expect(mockRefreshContactCache).toHaveBeenCalledWith(1, KEY, {
      cachedHandle: 'dee@deggen.com',
      cachedAvatarUrl: 'https://a/x.png',
      cachedCertifier: undefined
    })
  })

  /**
   * The same window, on a chain that HAS a registry — which is what the EAS
   * development profiles now configure for both chains. The registry client
   * exists from the first render while the identity client does not, so a
   * single once-per-visit guard is claimed by the pass that can only do the
   * registry half, and the avatar is then never refreshed for the whole visit
   * even though `managers` is a dependency precisely so that it could be.
   */
  it('still refreshes the avatar when the wallet arrives on a chain that has a registry', async () => {
    withRegistry()
    mockWallet.managers = {}
    mockResolveIdentity.mockResolvedValue([true, { avatarURL: 'https://a/x.png' }])
    mockLookupProfile.mockResolvedValue({ kind: 'found', profile: { paymail: 'dee@deggen.com' } })
    const s = draw()
    await waitFor(() => expect(mockLookupProfile).toHaveBeenCalledTimes(1))
    expect(mockResolveIdentity).not.toHaveBeenCalled()

    mockWallet.managers = { permissionsManager: {} }
    s.rerender(
      <ThemeProvider>
        <ContactScreen />
      </ThemeProvider>
    )
    await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(mockRefreshContactCache).toHaveBeenLastCalledWith(1, KEY, {
        cachedHandle: 'dee@deggen.com',
        cachedAvatarUrl: 'https://a/x.png',
        cachedCertifier: undefined
      })
    )
    // And the half already done is not asked again: one guard per source, not
    // one per pass.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mockLookupProfile).toHaveBeenCalledTimes(1)
    expect(mockResolveIdentity).toHaveBeenCalledTimes(1)
  })

  /**
   * `lookupProfile` answering `failed` is the registry not having answered.
   * Writing `''` for that would blank the handle every time this screen is
   * opened on a train.
   */
  it('leaves the cached handle alone when the registry could not be reached', async () => {
    withRegistry()
    mockLookupProfile.mockResolvedValue({ kind: 'failed' })
    const s = draw()
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mockRefreshContactCache).not.toHaveBeenCalled()
    expect(mockStored.cachedHandle).toBe('dee@deggen.com')
  })

  it('clears the handle only when the registry says the key holds none', async () => {
    withRegistry()
    mockLookupProfile.mockResolvedValue({ kind: 'none' })
    draw()
    await waitFor(() =>
      expect(mockRefreshContactCache).toHaveBeenCalledWith(1, KEY, {
        cachedHandle: undefined,
        cachedAvatarUrl: undefined,
        cachedCertifier: undefined
      })
    )
  })

  it('asks the domain the cached handle names, not the one this build is pinned to', async () => {
    withRegistry()
    mockStored = { identityKey: KEY, name: 'Dee', cachedHandle: 'dee@other.example' }
    draw()
    await waitFor(() => expect(mockLookupProfile).toHaveBeenCalledWith(KEY, 'other.example'))
  })

  it('asks the pinned registry for a contact with no cached handle at all', async () => {
    withRegistry()
    mockStored = { identityKey: KEY, name: 'Dee' }
    draw()
    await waitFor(() => expect(mockLookupProfile).toHaveBeenCalledWith(KEY, undefined))
  })

  /**
   * The once-per-visit guard is claimed before the lookups run, so anything
   * that changes `contact` mid-flight cancels the pass that claimed it —
   * renaming this contact is the one a person actually does. The guard has to
   * come back when that happens, or the visit's refresh is dropped for good.
   */
  it('refreshes after a rename cancels the pass mid-lookup', async () => {
    withRegistry()
    const pending: ((lookup: { kind: 'found'; profile: { paymail: string } }) => void)[] = []
    mockLookupProfile.mockImplementation(() => new Promise(resolve => pending.push(resolve)))
    const s = draw()
    await waitFor(() => expect(pending).toHaveLength(1))
    fireEvent.changeText(s.getByPlaceholderText('contact_new_title'), 'Dee from the pub quiz')
    fireEvent.press(s.getByLabelText('contact_save_name'))
    await waitFor(() => expect(mockRenameContact).toHaveBeenCalled())
    await waitFor(() => expect(pending).toHaveLength(2))
    pending.forEach(resolve => resolve({ kind: 'found', profile: { paymail: 'deggen@deggen.com' } }))
    await waitFor(() =>
      expect(mockRefreshContactCache).toHaveBeenCalledWith(1, KEY, {
        cachedHandle: 'deggen@deggen.com',
        cachedAvatarUrl: undefined,
        cachedCertifier: undefined
      })
    )
    // The cancelled pass bails at its own `cancelled` check, so only the pass
    // that survived writes — and the guard still stops the reload loop: two
    // rounds of lookups (the cancelled pass and the one that replaced it),
    // never a third off the row that pass produced.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mockRefreshContactCache).toHaveBeenCalledTimes(1)
    expect(mockLookupProfile).toHaveBeenCalledTimes(2)
  })

  /**
   * The lookups cannot reject (both are documented never-throws), but the write
   * and the reload behind it are SQLite, which rejects on a handle closing
   * under a fast navigate-away. Nothing may escape this effect unhandled.
   */
  it('swallows a write that rejects on a closing database', async () => {
    withRegistry()
    mockLookupProfile.mockResolvedValue({ kind: 'found', profile: { paymail: 'deggen@deggen.com' } })
    mockRefreshContactCache.mockRejectedValue(new Error('database is locked'))
    const s = draw()
    await waitFor(() => expect(mockRefreshContactCache).toHaveBeenCalled())
    // Nothing more to assert than this: the screen is still the screen, and an
    // escaped rejection fails this case on its own — jest reports one against
    // whichever test was running when it surfaced.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(s.getByText('dee@deggen.com')).toBeTruthy()
  })

  it('asks no registry at all when this chain has none, and still refreshes the avatar', async () => {
    mockResolveIdentity.mockResolvedValue([true, { avatarURL: 'https://a/x.png' }])
    draw()
    await waitFor(() => expect(mockRefreshContactCache).toHaveBeenCalledTimes(1))
    expect(mockLookupProfile).not.toHaveBeenCalled()
    expect(mockRefreshContactCache).toHaveBeenCalledWith(1, KEY, {
      cachedHandle: 'dee@deggen.com',
      cachedAvatarUrl: 'https://a/x.png',
      cachedCertifier: undefined
    })
  })
})

describe('ContactsScreen', () => {
  it('lists a cached handle as it is stored, and names the absence of one', async () => {
    mockRows = [
      { identityKey: KEY, name: 'Dee from the pub', cachedHandle: 'dee@deggen.com' },
      { identityKey: OTHER_KEY, name: 'Someone off a QR code' }
    ]
    const s = render(
      <ThemeProvider>
        <ContactsScreen />
      </ThemeProvider>
    )
    await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
    expect(s.queryByText('@dee@deggen.com')).toBeNull()
    expect(s.getByText('contact_no_handle')).toBeTruthy()
  })
})

describe('IdentifierScreen', () => {
  it('shows the registered paymail with no sigil in front of it', () => {
    mockRouteParams = { identityKey: KEY, name: 'Dee K', handle: 'dee@deggen.com' }
    const s = render(
      <ThemeProvider>
        <IdentifierScreen />
      </ThemeProvider>
    )
    expect(s.getByText('dee@deggen.com')).toBeTruthy()
    expect(s.queryByText('@dee@deggen.com')).toBeNull()
  })
})
