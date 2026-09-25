/**
 * XR-076 (SEC2-011): the Add Provider domain import must not be able to
 * enroll a trust-provider key over a downgraded connection. An on-path
 * attacker who can intercept an explicit `http://` origin (or force a
 * redirect away from the entered https origin) could otherwise substitute
 * the identityKey the user ends up trusting as a certifier.
 *
 * Mocking follows __tests__/ui/trustScreenIcons.test.tsx.
 */
import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('expo-local-authentication', () => ({
  getEnrolledLevelAsync: jest.fn(async () => 0),
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: false })),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 }
}))
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
  WHEN_UNLOCKED: 'wu',
  AFTER_FIRST_UNLOCK: 'afu',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wudo'
}))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('expo-router', () => ({ router: { back: jest.fn() } }))
jest.mock('expo-image', () => ({ Image: 'ExpoImage' }))
jest.mock('react-native-svg', () => ({ ...jest.requireActual('react-native-svg'), SvgUri: 'SvgUri' }))

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({
    settings: { trustSettings: { trustLevel: 1, trustedCertifiers: [] } },
    updateSettings: jest.fn()
  })
}))

import { TrustScreen } from '../../ui/screens/TrustScreen'

const draw = () => render(<TrustScreen />)

const openAddProviderModal = (screen: ReturnType<typeof draw>) => {
  fireEvent.press(screen.getByText('add_provider'))
}

beforeEach(() => {
  jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 599 } as unknown as Response)
})
afterEach(() => {
  jest.restoreAllMocks()
})

it('XR-076: never fetches an explicit http:// provider domain', async () => {
  const screen = draw()
  openAddProviderModal(screen)
  fireEvent.changeText(screen.getByPlaceholderText('trustedentity.com'), 'http://malicious.example')
  fireEvent.press(screen.getByText('get_provider_details'))

  await waitFor(() => expect(screen.getByText(/https/i)).toBeTruthy())
  expect(global.fetch).not.toHaveBeenCalled()
})

it('still fetches an ordinary bare domain over https', async () => {
  ;(global.fetch as jest.Mock).mockImplementation(async () => ({
    ok: false,
    status: 404
  }))
  const screen = draw()
  openAddProviderModal(screen)
  fireEvent.changeText(screen.getByPlaceholderText('trustedentity.com'), 'trustedentity.com')
  fireEvent.press(screen.getByText('get_provider_details'))

  await waitFor(() => expect(global.fetch).toHaveBeenCalled())
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
  expect(String(url)).toBe('https://trustedentity.com/manifest.json')
  expect(init?.redirect).toBe('error')
})

it('XR-073: never fetches a domain field typed as a loopback address, with no DNS trickery needed', async () => {
  const screen = draw()
  openAddProviderModal(screen)
  fireEvent.changeText(screen.getByPlaceholderText('trustedentity.com'), '127.0.0.1')
  fireEvent.press(screen.getByText('get_provider_details'))

  await waitFor(() => expect(screen.getByText('That domain does not name a public trust provider')).toBeTruthy())
  expect(global.fetch).not.toHaveBeenCalled()
})

/**
 * XR-074 (SEC2-012): every other JSON-consuming call site in the handle
 * registry (resolver.ts / client.ts) bounds body bytes before parsing
 * (XR-077) -- this screen's own manifest fetch never got that treatment. A
 * malicious or compromised trust-provider domain could answer with an
 * arbitrarily large body and force a full JSON parse/allocation before
 * validateTrust ever runs.
 */
it('XR-074: refuses a manifest response that declares more bytes than the limit, without ever parsing it', async () => {
  const jsonSpy = jest.fn().mockResolvedValue({ babbage: { trust: {} } })
  ;(global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? '5000000' : null) },
    json: jsonSpy
  })
  const screen = draw()
  openAddProviderModal(screen)
  fireEvent.changeText(screen.getByPlaceholderText('trustedentity.com'), 'trustedentity.com')
  fireEvent.press(screen.getByText('get_provider_details'))

  await waitFor(() => expect(screen.getByText(/byte limit/i)).toBeTruthy())
  expect(jsonSpy).not.toHaveBeenCalled()
})

it('XR-074: rejects a streamed manifest body once it crosses the byte cap, without buffering the rest of it', async () => {
  const chunk = new Uint8Array(64 * 1024)
  let pulls = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      controller.enqueue(chunk)
      if (pulls > 200) controller.close()
    }
  })
  ;(global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    headers: { get: () => null },
    body: stream,
    json: jest.fn()
  })
  const screen = draw()
  openAddProviderModal(screen)
  fireEvent.changeText(screen.getByPlaceholderText('trustedentity.com'), 'trustedentity.com')
  fireEvent.press(screen.getByText('get_provider_details'))

  await waitFor(() => expect(screen.getByText(/byte limit/i)).toBeTruthy())
  expect(pulls).toBeLessThan(10)
})

it('still parses an ordinary small manifest body with no declared Content-Length', async () => {
  // A body well under the cap must reach validateTrust unaffected -- proven by
  // failing for an ORDINARY, unrelated validation reason (name too short)
  // rather than the new byte-limit error.
  const jsonSpy = jest.fn().mockResolvedValue({
    babbage: { trust: { name: 'ab', note: 'a normal note', icon: '', publicKey: '02' + '11'.repeat(32) } }
  })
  ;(global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    headers: { get: () => null },
    json: jsonSpy
  })
  const screen = draw()
  openAddProviderModal(screen)
  fireEvent.changeText(screen.getByPlaceholderText('trustedentity.com'), 'trustedentity.com')
  fireEvent.press(screen.getByText('get_provider_details'))

  await waitFor(() => expect(jsonSpy).toHaveBeenCalled())
  await waitFor(() => expect(screen.getByText(/name must be 5-30/i)).toBeTruthy())
})
