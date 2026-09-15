/**
 * The Home balance surfaces for stablecoins.
 *
 * What these pin is the design's hardest rule — never print a number the wallet
 * cannot stand behind: fixed decimals rather than trimmed ones, a spinner
 * rather than a zero for an unknown balance, the "not yet confirmed" qualifier
 * on money that arrived offline, and nothing at all on a wallet that holds no
 * token.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', MaterialCommunityIcons: 'MaterialCommunityIcons' }))
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join('|')}` : key,
    i18n: { language: 'en' }
  }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))

import React from 'react'
import { render } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import AssetAmount from '../../ui/components/wallet/AssetAmount'
import AssetRow from '../../ui/components/wallet/AssetRow'
import BalancesSection from '../../ui/components/wallet/BalancesSection'
import { formatTokenAmount, parseTokenAmount, tokenAmountInputText } from '../../ui/tokenFormat'
import { balanceOf, USDX, EURX } from '../__mocks__/fakeMandalaRuntime'

const wrap = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

describe('formatTokenAmount', () => {
  it('keeps the asset\'s decimals fixed — money, not a quantity', () => {
    expect(formatTokenAmount(124000, 2)).toBe('1,240.00')
    expect(formatTokenAmount(100, 2)).toBe('1.00')
    expect(formatTokenAmount(1, 2)).toBe('0.01')
    expect(formatTokenAmount(0, 2)).toBe('0.00')
  })

  it('handles a zero-decimal asset without inventing a point', () => {
    expect(formatTokenAmount(42, 0)).toBe('42')
  })

  it('does the split on the integer, so no figure is lost to floating point', () => {
    expect(formatTokenAmount(90071992547409, 2)).toBe('900,719,925,474.09')
  })

  it('signs a negative figure and refuses a non-finite one', () => {
    expect(formatTokenAmount(-2500, 2)).toBe('−25.00')
    expect(formatTokenAmount(Number.NaN, 2)).toBeNull()
  })

  it('adds a plus only when asked', () => {
    expect(formatTokenAmount(4000, 2, { showPlus: true })).toBe('+40.00')
  })
})

describe('parseTokenAmount', () => {
  it('maps a typed figure to whole base units', () => {
    expect(parseTokenAmount('25', 2)).toBe(2500)
    expect(parseTokenAmount('25.5', 2)).toBe(2550)
    expect(parseTokenAmount('25.05', 2)).toBe(2505)
    expect(parseTokenAmount('.5', 2)).toBe(50)
  })

  it('refuses blank, junk and over-precise input rather than rounding it', () => {
    expect(parseTokenAmount('', 2)).toBeNull()
    expect(parseTokenAmount('abc', 2)).toBeNull()
    expect(parseTokenAmount('25.005', 2)).toBeNull()
  })

  it('round-trips the Max figure the field writes', () => {
    expect(parseTokenAmount(tokenAmountInputText(112000, 2), 2)).toBe(112000)
  })
})

describe('AssetAmount', () => {
  it('draws the figure and its unit, with one composed label for VoiceOver', () => {
    const s = wrap(<AssetAmount baseUnits={124000} asset={USDX} />)
    // The two halves are drawn but hidden from the accessibility tree on
    // purpose, so the figure and its unit are never read as two fragments.
    expect(s.getByText('1,240.00', { includeHiddenElements: true })).toBeTruthy()
    expect(s.getByText('USDX', { includeHiddenElements: true })).toBeTruthy()
    expect(s.getByLabelText('1,240.00 USDX')).toBeTruthy()
  })

  it('shows a spinner for an unknown balance and never a zero', () => {
    const s = wrap(<AssetAmount baseUnits={null} asset={USDX} />)
    expect(s.queryByText('0.00')).toBeNull()
    expect(s.UNSAFE_getByType(require('react-native').ActivityIndicator)).toBeTruthy()
  })
})

describe('AssetRow', () => {
  it('names the asset and its figure as one accessibility element', () => {
    const s = wrap(<AssetRow balance={balanceOf()} onPress={jest.fn()} />)
    expect(s.getByText('Acme Dollar')).toBeTruthy()
    expect(s.getByLabelText('Acme Dollar, 1,240.00 USDX')).toBeTruthy()
  })

  it('offers the disclosure route on a first hold', () => {
    const s = wrap(<AssetRow balance={balanceOf()} isNew onPress={jest.fn()} />)
    expect(s.getByText('token_new_tap')).toBeTruthy()
  })

  it('qualifies money that arrived offline with the issuer who has not confirmed it', () => {
    const s = wrap(<AssetRow balance={balanceOf(USDX, 124000, 4000)} isNew onPress={jest.fn()} />)
    expect(s.getByText('local_pay_token_not_cleared:Acme Bank')).toBeTruthy()
    // The qualifier wins the one subtitle slot: an unconfirmed figure is a
    // fact about money, "new" is a fact about a sheet.
    expect(s.queryByText('token_new_tap')).toBeNull()
  })

  it('falls back to a nameless issuer rather than printing a key', () => {
    const anonymous = { ...USDX, issuerName: undefined }
    const s = wrap(<AssetRow balance={balanceOf(anonymous, 100, 100)} onPress={jest.fn()} />)
    expect(s.getByText('local_pay_token_not_cleared:token_issuer_fallback')).toBeTruthy()
  })
})

describe('BalancesSection', () => {
  it('renders nothing at all for a wallet that has never held a token', () => {
    expect(wrap(<BalancesSection balances={[]} onPress={jest.fn()} />).toJSON()).toBeNull()
    expect(wrap(<BalancesSection balances={null} onPress={jest.fn()} />).toJSON()).toBeNull()
  })

  it('lists one row per held asset under the Balances header', () => {
    const s = wrap(<BalancesSection balances={[balanceOf(), balanceOf(EURX, 5000)]} onPress={jest.fn()} />)
    expect(s.getByText('TOKEN_BALANCES_HEADER')).toBeTruthy()
    expect(s.getByText('Acme Dollar')).toBeTruthy()
    expect(s.getByText('Euro Coin')).toBeTruthy()
  })

  it('shows the fee footer only when the fee balance is provably zero', () => {
    expect(wrap(<BalancesSection balances={[balanceOf()]} spendableSats={0} onPress={jest.fn()} />).getByText(
      'token_fee_footer'
    )).toBeTruthy()
    // null is UNKNOWN, and `null < n` is true in JavaScript — the exact trap
    // this check exists to avoid.
    expect(
      wrap(<BalancesSection balances={[balanceOf()]} spendableSats={null} onPress={jest.fn()} />).queryByText(
        'token_fee_footer'
      )
    ).toBeNull()
    expect(
      wrap(<BalancesSection balances={[balanceOf()]} spendableSats={50_000_000} onPress={jest.fn()} />).queryByText(
        'token_fee_footer'
      )
    ).toBeNull()
  })
})
