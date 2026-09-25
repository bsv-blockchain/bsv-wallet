/**
 * XR-070 (SEC2-061): IdentifierScreen is "Your Identifier" — a QR/copy/share
 * of THIS wallet's own key. It is reached through a deep link
 * (`bsv-wallet://identifier?identityKey=...`, via `app/+native-intent.ts` /
 * `resolveNativeIntent`, which carries no blocklist for `identifier`) as well
 * as from Profile's own in-app push of its already-known key. Only the second
 * case is trustworthy; a crafted link supplying someone else's key must never
 * reach the QR, the copy button or the share sheet.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve())
}))
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('react-native-qrcode-svg', () => 'QRCode')
jest.mock('@react-native-clipboard/clipboard', () => ({ default: { setString: jest.fn() } }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))

let mockRouteParams: Record<string, string> = {}
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => mockRouteParams
}))

const mockGetPublicKey = jest.fn()
const mockWallet = {
  managers: { permissionsManager: { getPublicKey: (...a: unknown[]) => mockGetPublicKey(...a) } },
  adminOriginator: 'admin.com'
}
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => mockWallet
}))

import React from 'react'
import { render, waitFor } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import { IdentifierScreen } from '../../ui/screens/IdentifierScreen'
import { contactAddLinkFor } from '../../core/identity/contactLink'

const WALLET_KEY = '02' + 'ab'.repeat(32)
const ATTACKER_KEY = '03' + 'ef'.repeat(32)

const draw = () =>
  render(
    <ThemeProvider>
      <IdentifierScreen />
    </ThemeProvider>
  )

beforeEach(() => {
  jest.clearAllMocks()
  mockGetPublicKey.mockResolvedValue({ publicKey: WALLET_KEY })
})

it('XR-070: ignores a deep-linked identityKey that is not this wallet — the QR/link is always the real key', async () => {
  mockRouteParams = { identityKey: ATTACKER_KEY, name: 'Trusted Friend', handle: 'friend@example.com' }
  const s = draw()

  await waitFor(() => expect(mockGetPublicKey).toHaveBeenCalled())
  await waitFor(() => expect(s.getByText(contactAddLinkFor(WALLET_KEY))).toBeTruthy())

  expect(s.queryByText(contactAddLinkFor(ATTACKER_KEY))).toBeNull()
  // The attacker-supplied cosmetic labels must not surface either, since they
  // arrived attached to a key that turned out not to be ours.
  expect(s.queryByText('Trusted Friend')).toBeNull()
  expect(s.queryByText('friend@example.com')).toBeNull()
})

it('XR-070: shows nothing to copy/share before the real key has resolved, even with a route hint present', () => {
  mockRouteParams = { identityKey: ATTACKER_KEY }
  mockGetPublicKey.mockReturnValue(new Promise(() => {})) // never resolves within this test
  const s = draw()
  expect(s.queryByText(contactAddLinkFor(ATTACKER_KEY))).toBeNull()
})

it('renders the route hint (name/handle) once it matches the wallet-derived key — the legitimate same-device case', async () => {
  mockRouteParams = { identityKey: WALLET_KEY, name: 'Dee K', handle: 'dee@deggen.com' }
  const s = draw()

  await waitFor(() => expect(s.getByText(contactAddLinkFor(WALLET_KEY))).toBeTruthy())
  expect(s.getByText('dee@deggen.com')).toBeTruthy()
})

it('resolves and shows the wallet key on a cold deep link with no route params at all', async () => {
  mockRouteParams = {}
  const s = draw()
  await waitFor(() => expect(s.getByText(contactAddLinkFor(WALLET_KEY))).toBeTruthy())
})
