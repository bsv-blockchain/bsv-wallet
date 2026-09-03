/**
 * The universal send form recomposes by what the recipient field resolved to.
 * These tests drive the field and check which questions the form then asks —
 * not the send itself, which the rail tests cover.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), dismissTo: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {}
}))
jest.mock('../../ui/components/QRScanner', () => 'QRScanner')
jest.mock('../../ui/screens/WalletCheckScreen', () => ({ promptCheckWallet: jest.fn() }))
jest.mock('../../ui/components/pay/AvailableBalance', () => {
  const { Text } = require('react-native')
  return { __esModule: true, default: () => <Text testID="available-balance">balance</Text> }
})
jest.mock('../../ui/components/wallet/AmountInput', () => {
  const { TextInput } = require('react-native')
  return {
    __esModule: true,
    SEND_MAX_VALUE: '2099999999999999',
    AmountInput: ({ value, onChangeText }: { value: string; onChangeText: (v: string) => void }) => (
      <TextInput testID="amount-input" value={value} onChangeText={onChangeText} />
    )
  }
})
// wallet null: no IdentityClient, no PeerPay client, no outbox read. The form's
// composition does not depend on any of them.
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({ managers: null, adminOriginator: 'admin.com', storage: undefined })
}))

import React from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import UniversalSend from '../../ui/components/pay/UniversalSend'

const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
const BROKEN_ADDRESS = ADDRESS.slice(0, -1) + '3'

const draw = (props: Partial<React.ComponentProps<typeof UniversalSend>> = {}) =>
  render(
    <ThemeProvider>
      <UniversalSend onNearbySession={jest.fn()} {...props} />
    </ThemeProvider>
  )

describe('UniversalSend', () => {
  it('opens with the universal placeholder, an amount, and neither note nor consequence', () => {
    const s = draw()
    expect(s.getByPlaceholderText('recipient_placeholder')).toBeTruthy()
    expect(s.getByText('amount')).toBeTruthy()
    expect(s.queryByText('note')).toBeNull()
    expect(s.queryByText('pay_conseq_address')).toBeNull()
    expect(s.queryByText('pay_conseq_handle')).toBeNull()
  })

  it('an address: valid-address row, address consequence, no note field', async () => {
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), ADDRESS)
    await waitFor(() => expect(s.getByText('valid_bsv_address')).toBeTruthy())
    expect(s.getByText('pay_conseq_address')).toBeTruthy()
    expect(s.queryByText('note')).toBeNull()
  })

  it('a key: valid-key row, note field, and no consequence callout', async () => {
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    expect(s.getByText('note')).toBeTruthy()
    expect(s.queryByText('pay_conseq_address')).toBeNull()
    expect(s.queryByText('pay_conseq_handle')).toBeNull()
  })

  it('a checksum-broken address: inline error, nothing else', async () => {
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), BROKEN_ADDRESS)
    await waitFor(() => expect(s.getByText('invalid_bsv_address')).toBeTruthy())
    expect(s.queryByText('valid_bsv_address')).toBeNull()
    expect(s.queryByText('pay_conseq_address')).toBeNull()
  })

  it('prefills from an initial handle target and amount', () => {
    const s = draw({ initialTarget: { kind: 'handle', identityKey: KEY }, initialSats: 1500 })
    expect(s.getByText('valid_identity_key')).toBeTruthy()
    expect(s.getByTestId('amount-input').props.value).toBe('1500')
  })

  it('shows an initial notice as a banner', () => {
    const s = draw({ initialNotice: 'PeerPay link contains an invalid identity key' })
    expect(s.getByText('PeerPay link contains an invalid identity key')).toBeTruthy()
  })

  it('a second deep link replaces the amount on screen', () => {
    const s = draw({ initialTarget: { kind: 'handle', identityKey: KEY }, initialSats: 5000 })
    fireEvent.changeText(s.getByTestId('amount-input'), '1234')
    expect(s.getByTestId('amount-input').props.value).toBe('1234')
    s.rerender(
      <ThemeProvider>
        <UniversalSend
          onNearbySession={jest.fn()}
          initialTarget={{ kind: 'handle', identityKey: KEY }}
          initialSats={200}
        />
      </ThemeProvider>
    )
    expect(s.getByTestId('amount-input').props.value).toBe('200')
  })

  it('a second, malformed deep link raises its notice as a banner', () => {
    const s = draw({ initialTarget: { kind: 'handle', identityKey: KEY }, initialSats: 5000 })
    s.rerender(
      <ThemeProvider>
        <UniversalSend onNearbySession={jest.fn()} initialNotice="bad" />
      </ThemeProvider>
    )
    expect(s.getByText('bad')).toBeTruthy()
  })

  it('never shows the message-box server bar', () => {
    const s = draw()
    expect(s.queryByLabelText('message_box_server')).toBeNull()
  })

  it('leaves the form intact and shows a banner when the wallet is not ready', async () => {
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), ADDRESS)
    fireEvent.changeText(s.getByTestId('amount-input'), '500')
    await waitFor(() => expect(s.getByText('valid_bsv_address')).toBeTruthy())
    fireEvent.press(s.getByLabelText('pay'))
    await waitFor(() => expect(s.getByText('wallet_not_ready')).toBeTruthy())
    expect(s.getByPlaceholderText('recipient_placeholder').props.value).toBe(ADDRESS)
    expect(s.getByTestId('amount-input').props.value).toBe('500')
  })
})
