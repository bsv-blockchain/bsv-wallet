/**
 * What `/contact/add` does with the `handle` param: it is the only production
 * writer of `cachedHandle`, and the route is deep-linkable, so the param is
 * untrusted input that has to survive `parsePaymail` before it is stored.
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
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({ walletUserId: 1, managers: null, adminOriginator: 'admin.com', storage: undefined })
}))

import React from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import { NewContactScreen } from '../../ui/screens/NewContactScreen'

const KEY = '02' + 'ab'.repeat(32)
const draw = () =>
  render(
    <ThemeProvider>
      <NewContactScreen />
    </ThemeProvider>
  )

beforeEach(() => {
  jest.clearAllMocks()
  mockCreateContact.mockResolvedValue({})
  mockRouteParams = {}
})

describe('a contact saved from a registry hit', () => {
  it('stores the handle it arrived with, and prefills the public name as an editable one', async () => {
    mockRouteParams = { identityKey: KEY, name: 'Dee K', handle: 'Dee@Deggen.com', source: 'pay' }
    const s = draw()
    expect(s.getByText('dee@deggen.com')).toBeTruthy()
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
    mockRouteParams = { identityKey: KEY, name: 'Dee K', source: 'qr' }
    const s = draw()
    expect(s.getByText('contact_no_handle_registered')).toBeTruthy()
    fireEvent.press(s.getByText('contact_save'))
    await waitFor(() =>
      expect(mockCreateContact).toHaveBeenCalledWith(expect.not.objectContaining({ cachedHandle: expect.anything() }))
    )
  })

  /**
   * `/contact/add` is deep-linkable, so this param is untrusted input, and
   * what it becomes is shown under a shield and the words "only they can
   * change it". A string that is not a paymail is not a handle.
   */
  it.each(['not-a-paymail', 'dee@', '@deggen.com', 'Dee <script>@deggen.com', 'a@b@c'])(
    'refuses %s as a handle rather than displaying it as a verified one',
    async (raw: string) => {
      mockRouteParams = { identityKey: KEY, name: 'Dee K', handle: raw, source: 'pay' }
      const s = draw()
      expect(s.getByText('contact_no_handle_registered')).toBeTruthy()
      expect(s.queryByText(raw)).toBeNull()
      fireEvent.press(s.getByText('contact_save'))
      await waitFor(() =>
        expect(mockCreateContact).toHaveBeenCalledWith(expect.not.objectContaining({ cachedHandle: expect.anything() }))
      )
    }
  )
})
