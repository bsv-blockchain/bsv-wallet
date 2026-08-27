jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}))

jest.mock('react-native-svg', () => {
  const React = require('react')
  const { View } = require('react-native')
  const Svg = ({ children }: { children?: React.ReactNode }) => React.createElement(View, null, children)
  const Circle = () => null
  const Path = React.forwardRef((_props: object, _ref: unknown) => null)
  Path.displayName = 'Path'
  return { __esModule: true, default: Svg, Svg, Circle, Path }
})

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
import * as Haptics from 'expo-haptics'
import Celebration from '@/components/ui/Celebration'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'

jest.useFakeTimers()

const wrapper = (onDone?: () => void) =>
  render(
    <ThemeProvider>
      <Celebration onDone={onDone} />
    </ThemeProvider>
  )

describe('Celebration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders without crashing', () => {
    expect(() => wrapper()).not.toThrow()
  })

  it('fires success haptic on mount', () => {
    wrapper()
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success,
    )
  })

  it('calls onDone after timers advance past 700ms', () => {
    const onDone = jest.fn()
    wrapper(onDone)
    expect(onDone).not.toHaveBeenCalled()
    act(() => { jest.advanceTimersByTime(700) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
