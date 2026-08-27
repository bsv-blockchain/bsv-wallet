jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}))

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}))

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}))

// Pulled in as a side effect of importing anything from the barrel: its
// LocalStorageProvider chain reaches these native modules at module top level.
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

import React from 'react'
import { render, act } from '@testing-library/react-native'
import { ToastHost, showToast } from '@/components/ui/Toast'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'

jest.useFakeTimers()

describe('showToast', () => {
  it('renders message, newest wins, auto-dismisses after 2s', () => {
    const screen = render(<ThemeProvider><ToastHost /></ThemeProvider>)
    act(() => { showToast('Copied') })
    expect(screen.getByText('Copied')).toBeTruthy()
    act(() => { showToast('Exported', { type: 'success' }) })
    expect(screen.queryByText('Copied')).toBeNull()
    expect(screen.getByText('Exported')).toBeTruthy()
    act(() => { jest.advanceTimersByTime(2600) })
    expect(screen.queryByText('Exported')).toBeNull()
  })
})
