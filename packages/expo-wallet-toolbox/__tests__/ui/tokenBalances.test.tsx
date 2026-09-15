/**
 * The token amount format helpers and the `AssetAmount` figure component.
 *
 * There is no Home Balances block any more (2026-09-15 maintainer decision —
 * see walletHomeTokens.test.tsx for what Home renders instead), but the
 * formatting rules these components exist to enforce still apply everywhere a
 * token figure is drawn (the Pay asset picker, the amount field, activity):
 * fixed decimals rather than trimmed ones, and a spinner rather than a zero
 * for an unknown balance.
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
import { formatTokenAmount, parseTokenAmount, tokenAmountInputText } from '../../ui/tokenFormat'
import { USDX } from '../__mocks__/fakeMandalaRuntime'

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
