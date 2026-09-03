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
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
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

import React from 'react'
import { fireEvent, render } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import RequestHub, { requestSatsFrom } from '../../ui/components/pay/RequestHub'

const draw = (props: Partial<React.ComponentProps<typeof RequestHub>> = {}) =>
  render(
    <ThemeProvider>
      <RequestHub requestSats="" onChangeRequestSats={jest.fn()} onPick={jest.fn()} online {...props} />
    </ThemeProvider>
  )

describe('RequestHub', () => {
  it('asks for an amount with no balance line, then lists three methods under a Method label', () => {
    const s = draw()
    expect(s.getByText('amount')).toBeTruthy()
    expect(s.queryByTestId('available-balance')).toBeNull()
    expect(s.getByText('pay_method')).toBeTruthy()
    expect(s.getByText('pay_method_nearby')).toBeTruthy()
    expect(s.getByText('pay_method_remote_link')).toBeTruthy()
    expect(s.getByText('pay_method_address')).toBeTruthy()
  })

  it('does not show the retired "leave it at zero" hint', () => {
    expect(draw().queryByText('local_pay_amount_optional_hint')).toBeNull()
  })

  it('passes amount edits up and reports the picked method', () => {
    const onChangeRequestSats = jest.fn()
    const onPick = jest.fn()
    const s = draw({ onChangeRequestSats, onPick })
    fireEvent.changeText(s.getByTestId('amount-input'), '2500')
    expect(onChangeRequestSats).toHaveBeenCalledWith('2500')
    fireEvent.press(s.getByText('pay_method_remote_link'))
    expect(onPick).toHaveBeenCalledWith('get-handle')
    fireEvent.press(s.getByText('pay_method_nearby'))
    expect(onPick).toHaveBeenCalledWith('get-nearby')
    fireEvent.press(s.getByText('pay_method_address'))
    expect(onPick).toHaveBeenCalledWith('get-address')
  })

  it('disables remote link and address offline, leaving nearby alone', () => {
    const s = draw({ online: false })
    // PayCellRow's accessibility label is `${title}. ${subtitle}`.
    expect(s.getByLabelText('pay_method_nearby. pay_cell_nearby_get_sub').props.accessibilityState.disabled).toBe(false)
    expect(
      s.getByLabelText('pay_method_remote_link. pay_offline_needs_internet').props.accessibilityState.disabled
    ).toBe(true)
    expect(s.getByLabelText('pay_method_address. pay_offline_needs_internet').props.accessibilityState.disabled).toBe(
      true
    )
  })
})

describe('requestSatsFrom', () => {
  it('maps blank, zero, negative and junk to an open request', () => {
    expect(requestSatsFrom('')).toBeUndefined()
    expect(requestSatsFrom('0')).toBeUndefined()
    expect(requestSatsFrom('-5')).toBeUndefined()
    expect(requestSatsFrom('abc')).toBeUndefined()
  })
  it('rounds a positive figure to whole satoshis', () => {
    expect(requestSatsFrom('2500')).toBe(2500)
    expect(requestSatsFrom('2500.4')).toBe(2500)
  })
})
