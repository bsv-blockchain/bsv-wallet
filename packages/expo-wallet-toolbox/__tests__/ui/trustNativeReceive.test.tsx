import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

jest.mock('react-native', () => ({
  ...jest.requireActual('react-native'),
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  Modal: 'Modal',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
jest.mock('react-native-svg', () => ({ SvgUri: 'SvgUri' }), { virtual: true })
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }), { virtual: true })
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (value: string) => value }) }), { virtual: true })
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }), { virtual: true })
jest.mock('expo-router', () => ({ router: { back: jest.fn() } }), { virtual: true })
jest.mock('expo-image', () => ({ Image: Object.assign(() => null, { prefetch: async () => true }) }), { virtual: true })
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: jest.fn(async () => 'cancel') }))
jest.mock(
  '@bsv/expo-wallet-toolbox',
  () => ({
    haptics: { selection: jest.fn(), success: jest.fn() },
    useTheme: () => ({ colors: {} }),
    spacing: {},
    radii: {},
    typography: {},
    useWallet: () => ({ settings: { trustSettings: { trustedCertifiers: [] } }, updateSettings: jest.fn() })
  }),
  { virtual: true }
)

const mockRequest = jest.fn()
jest.mock(
  'expo-modules-core',
  () => ({
    requireNativeModule: () => ({ request: mockRequest, cancel: jest.fn(async () => {}) })
  }),
  { virtual: true }
)

import { TrustScreen } from '../../ui/screens/TrustScreen'

let screen: ReactTestRenderer

function button(text: string) {
  return screen.root
    .findAllByType('TouchableOpacity' as never)
    .find(node => node.findAllByType('Text' as never).some(label => label.children.includes(text)))!
}

beforeEach(async () => {
  mockRequest.mockReset()
  await act(async () => {
    screen = create(<TrustScreen />)
  })
  await act(async () => {
    button('add_provider').props.onPress()
  })
  await act(async () => {
    screen.root.findByProps({ placeholder: 'trustedentity.com' }).props.onChangeText('provider.example')
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
    await button('get_provider_details').props.onPress()
  })
  expect(mockRequest).toHaveBeenCalledTimes(1)
  expect(mockRequest.mock.calls[0][0]).toMatchObject({
    url: 'https://provider.example/manifest.json',
    maxBytes: 64 * 1024,
    method: 'GET'
  })
  expect(screen.root.findAllByType('Text' as never).some(node => node.children.includes('Provider Name'))).toBe(true)
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
      await button('get_provider_details').props.onPress()
    })
    expect(unbounded).not.toHaveBeenCalled()
    expect(
      screen.root
        .findAllByType('Text' as never)
        .some(node =>
          node.children.some(value => typeof value === 'string' && value.includes('Could not fetch the trust data'))
        )
    ).toBe(true)
  } finally {
    Object.defineProperty(globalThis, 'fetch', original)
  }
})
