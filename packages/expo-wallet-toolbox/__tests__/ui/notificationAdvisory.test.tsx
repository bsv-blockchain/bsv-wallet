/**
 * NotificationAdvisoryModal: the one-time heads-up before the OS asks to allow
 * notifications, shown the first time the user picks "Share remote link".
 * The gating lives in a pure helper so it is testable without the screen.
 */
import React from 'react'
import { fireEvent, render } from '@testing-library/react-native'

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} }),
  i18n: jest.requireActual('../../core/i18n/translations').default
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return {
    __esModule: true,
    default: ({ children, onPress, ...rest }: any) => (
      <Pressable onPress={onPress} {...rest}>
        {children}
      </Pressable>
    )
  }
})

import {
  NotificationAdvisoryModal,
  shouldShowNotificationAdvisory as show
} from '../../ui/components/pay/NotificationAdvisoryModal'

describe('shouldShowNotificationAdvisory', () => {
  it('shows only on first get-handle with undetermined permission', () => {
    expect(show({ method: 'get-handle', advisorySeen: false, permission: 'undetermined' })).toBe(true)
  })
  it.each([
    [{ method: 'get-nearby', advisorySeen: false, permission: 'undetermined' }],
    [{ method: 'get-address', advisorySeen: false, permission: 'undetermined' }],
    [{ method: 'get-handle', advisorySeen: true, permission: 'undetermined' }],
    [{ method: 'get-handle', advisorySeen: null, permission: 'undetermined' }],
    [{ method: 'get-handle', advisorySeen: false, permission: 'granted' }],
    [{ method: 'get-handle', advisorySeen: false, permission: 'denied' }],
    [{ method: 'get-handle', advisorySeen: false, permission: null }]
  ] as const)('hides for %j', s => expect(show(s)).toBe(false))
})

describe('NotificationAdvisoryModal', () => {
  it('renders nothing while not visible', () => {
    const { queryByText } = render(
      <NotificationAdvisoryModal visible={false} onNotNow={() => {}} onContinue={() => {}} />
    )
    expect(queryByText("Get notified when you're paid")).toBeNull()
  })

  it('explains the coming OS prompt and what it is for', () => {
    const { getByText } = render(<NotificationAdvisoryModal visible onNotNow={() => {}} onContinue={() => {}} />)
    expect(getByText("Get notified when you're paid")).toBeTruthy()
    expect(
      getByText(
        'Next, your phone will ask to allow notifications. This lets BSV Wallet tell you when a payment arrives, even while the app is in the background.'
      )
    ).toBeTruthy()
  })

  it('routes Continue and Not now to their own callbacks', () => {
    const onContinue = jest.fn()
    const onNotNow = jest.fn()
    const { getByText } = render(<NotificationAdvisoryModal visible onNotNow={onNotNow} onContinue={onContinue} />)

    fireEvent.press(getByText('Not now'))
    expect(onNotNow).toHaveBeenCalledTimes(1)
    expect(onContinue).not.toHaveBeenCalled()

    fireEvent.press(getByText('Continue'))
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(onNotNow).toHaveBeenCalledTimes(1)
  })
})
