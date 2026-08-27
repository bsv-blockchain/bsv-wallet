jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
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
import { render, fireEvent, act } from '@testing-library/react-native'
import { AlertHost, showAlert } from '@/components/ui/AlertCard'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'

const host = () => render(<ThemeProvider><AlertHost /></ThemeProvider>)

describe('showAlert', () => {
  it('renders title/message and resolves pressed button key', async () => {
    const screen = host()
    let result!: Promise<string>
    act(() => {
      result = showAlert({
        title: 'Delete Certifier?',
        message: 'Apps will no longer resolve identities.',
        buttons: [
          { text: 'Cancel', style: 'cancel', key: 'cancel' },
          { text: 'Delete', style: 'destructive', key: 'delete' },
        ],
      })
    })
    expect(screen.getByText('Delete Certifier?')).toBeTruthy()
    expect(screen.getByText('Apps will no longer resolve identities.')).toBeTruthy()
    fireEvent.press(screen.getByText('Delete'))
    await expect(result).resolves.toBe('delete')
  })

  it('defaults to a single OK button resolving "ok"', async () => {
    const screen = host()
    let result!: Promise<string>
    act(() => { result = showAlert({ title: 'Heads up' }) })
    fireEvent.press(screen.getByText('OK'))
    await expect(result).resolves.toBe('ok')
  })

  it('double-dismiss within exit window: second alert renders and resolves', async () => {
    jest.useFakeTimers()
    const screen = host()

    let resultA!: Promise<string>
    let resultB!: Promise<string>

    act(() => {
      resultA = showAlert({
        title: 'Alert A',
        buttons: [{ text: 'Confirm', key: 'confirm' }],
      })
      resultB = showAlert({
        title: 'Alert B',
        buttons: [{ text: 'OK', key: 'ok' }],
      })
    })

    // First press — valid dismiss.
    fireEvent.press(screen.getByText('Confirm'))
    await expect(resultA).resolves.toBe('confirm')

    // Second press within exit window — must be ignored (exiting.current guard).
    fireEvent.press(screen.getByText('Confirm'))

    // Advance timers past durations.instant (150ms) so the queue slice fires.
    act(() => { jest.advanceTimersByTime(200) })

    // Alert B should now be visible.
    expect(screen.getByText('Alert B')).toBeTruthy()

    // Pressing Alert B's button should resolve its promise.
    fireEvent.press(screen.getByText('OK'))
    await expect(resultB).resolves.toBe('ok')

    jest.useRealTimers()
  })
})
