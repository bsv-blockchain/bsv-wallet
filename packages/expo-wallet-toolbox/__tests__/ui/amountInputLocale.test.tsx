/**
 * AmountInput's fiat mask and parser hardcoded '.' as the decimal separator,
 * so a comma-decimal locale could not type a fractional fiat amount at all —
 * every comma keystroke was rejected by the mask (reviews/misc-p2.md
 * misc-p2-12). The device locale is resolved once at module load in
 * numberFormat.ts, so it is mocked here rather than passed as a parameter.
 */
let mockLocale = 'en-US'
jest.mock('../../core/numberFormat', () => ({
  getNumberLocale: () => mockLocale
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)

let mockCurrency = 'EUR'
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({ settings: { currency: mockCurrency } })
}))

import React from 'react'
import { fireEvent, render } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import { AmountInput } from '../../ui/components/wallet/AmountInput'

const wrap = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

beforeEach(() => {
  mockLocale = 'en-US'
  mockCurrency = 'EUR'
})

describe('AmountInput under a comma-decimal locale', () => {
  it('typing "3,50" emits the same satoshis as "3.50" does under a dot locale', () => {
    const onChangeText = jest.fn()

    mockLocale = 'en-US'
    const dotRender = wrap(<AmountInput value="" onChangeText={onChangeText} />)
    fireEvent.changeText(dotRender.getByPlaceholderText('0.00'), '3.50')
    const dotSats = onChangeText.mock.calls.at(-1)?.[0]
    expect(dotSats).toBeTruthy()

    onChangeText.mockClear()
    mockLocale = 'de-DE'
    const commaRender = wrap(<AmountInput value="" onChangeText={onChangeText} />)
    fireEvent.changeText(commaRender.getByPlaceholderText('0.00'), '3,50')
    const commaSats = onChangeText.mock.calls.at(-1)?.[0]

    expect(commaSats).toBe(dotSats)
  })

  it('a lone "," is accepted by the mask under a comma locale, unlike "."', () => {
    mockLocale = 'de-DE'
    const onChangeText = jest.fn()
    const { getByPlaceholderText } = wrap(<AmountInput value="" onChangeText={onChangeText} />)
    const input = getByPlaceholderText('0.00')

    fireEvent.changeText(input, '3,5')
    expect(onChangeText).toHaveBeenCalled()
  })

  it('BSV (integer) mode keeps its digit-only mask regardless of locale', () => {
    mockLocale = 'de-DE'
    mockCurrency = 'BSV'
    const onChangeText = jest.fn()
    const { getByPlaceholderText } = wrap(<AmountInput value="" onChangeText={onChangeText} />)
    fireEvent.changeText(getByPlaceholderText('0'), '12345')
    expect(onChangeText).toHaveBeenLastCalledWith('12345')
  })
})
