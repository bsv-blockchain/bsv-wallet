import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

jest.mock('react-native-svg', () => ({ SvgUri: 'SvgUri' }))
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }))
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (value: string) => value }) }))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('expo-router', () => ({ router: { back: jest.fn() } }))
jest.mock('expo-image', () => ({ Image: Object.assign(() => null, { prefetch: async () => true }) }))
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: jest.fn(async () => 'cancel') }))
jest.mock('../../core/index', () => ({
  haptics: { selection: jest.fn(), success: jest.fn() },
  useTheme: () => ({ colors: {} }),
  spacing: {},
  radii: {},
  typography: {},
  useWallet: () => ({ settings: { trustSettings: { trustedCertifiers: [] } }, updateSettings: jest.fn() })
}))

const mockRequest = jest.fn()
jest.mock(
  'expo-modules-core',
  () => ({
    requireNativeModule: () => ({ request: mockRequest, cancel: jest.fn(async () => {}) })
  }),
  { virtual: true }
)

import { TrustScreen } from '../../ui/screens/TrustScreen'

let screen: ReturnType<typeof render>

function button(text: string) {
  return screen.getByText(text)
}

beforeEach(async () => {
  mockRequest.mockReset()
  screen = render(<TrustScreen />)
  await act(async () => {
    fireEvent.press(button('add_provider'))
  })
  await act(async () => {
    fireEvent.changeText(screen.getByPlaceholderText('trustedentity.com'), 'provider.example')
  })
})
afterEach(async () => {
  await act(async () => screen.unmount())
})

it('imports provider details through the native receive ceiling', async () => {
  mockRequest.mockResolvedValue({
    status: 200,
    headers: [],
    body: Buffer.from(
      JSON.stringify({
        babbage: {
          trust: {
            name: 'Provider Name',
            note: 'Provider description',
            icon: 'https://provider.example/icon.png',
            publicKey: '02' + 'ab'.repeat(32)
          }
        }
      })
    ).toString('base64')
  })
  await act(async () => {
    fireEvent.press(button('get_provider_details'))
  })
  expect(mockRequest).toHaveBeenCalledTimes(1)
  expect(mockRequest.mock.calls[0][0]).toMatchObject({
    url: 'https://provider.example/manifest.json',
    maxBytes: 64 * 1024,
    method: 'GET'
  })
  expect(screen.getByText('Provider Name')).toBeTruthy()
})

it('shows native size-limit failure without using global buffering fetch', async () => {
  mockRequest.mockRejectedValue(new Error('ERR_RESPONSE_TOO_LARGE'))
  // Expo installs fetch through a lazy native getter. Replace its descriptor
  // without initializing an unrelated native fetch module in this unit test.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch')!
  const unbounded = jest.fn()
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: unbounded })
  try {
    await act(async () => {
      fireEvent.press(button('get_provider_details'))
    })
    expect(unbounded).not.toHaveBeenCalled()
    expect(screen.getByText(/Could not fetch the trust data/)).toBeTruthy()
  } finally {
    Object.defineProperty(globalThis, 'fetch', original)
  }
})
