/**
 * AvailableBalance component tests: bare figure (no unit) vs. with AmountDisplay unit.
 */
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

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' }
  }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))

jest.mock('../../ui/components/wallet/AmountDisplay', () => {
  const { Text } = require('react-native')
  return { __esModule: true, default: () => <Text>DISPLAY</Text> }
})

jest.mock('../../ui/hooks/useSpendableBalance', () => ({
  useSpendableBalance: () => 150_000_000
}))

import React from 'react'
import { Text } from 'react-native'
import { render } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import AvailableBalance from '../../ui/components/pay/AvailableBalance'

// Mock @bsv/expo-wallet-toolbox partially
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({ settings: { currency: 'BSV' } })
}))

const wrap = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

describe('AvailableBalance', () => {
  it('default render shows bare figure with digits and available, no display component', () => {
    const screen = wrap(<AvailableBalance />)
    const tree = JSON.stringify(screen.toJSON())
    expect(tree).toMatch(/150.*000.*000/)
    expect(tree).toMatch(/available/)
    expect(tree).not.toMatch(/DISPLAY/)
  })

  it('withUnit render shows AmountDisplay and available', () => {
    const screen = wrap(<AvailableBalance withUnit />)
    const tree = JSON.stringify(screen.toJSON())
    const hasDisplay = /DISPLAY/.test(tree)
    const hasAvailable = /available/.test(tree)
    expect(hasDisplay).toBe(true)
    expect(hasAvailable).toBe(true)
  })
})
