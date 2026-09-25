/**
 * BiometricAdvisoryModal: the one-time consent gate shown before a wallet is
 * created. Its copy unconditionally promised "protected by Face ID or your
 * fingerprint" regardless of whether provisioning would actually land on a
 * disclosed, non-biometric policy for this device/build (XR-114).
 */
import React from 'react'
import { render } from '@testing-library/react-native'

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

import { BiometricAdvisoryModal } from '../../ui/components/wallet/BiometricAdvisoryModal'

describe('BiometricAdvisoryModal', () => {
  it('promises Face ID/fingerprint protection when the device will actually get it', () => {
    const { getByText, queryByText } = render(
      <BiometricAdvisoryModal visible degraded={false} onCancel={() => {}} onContinue={() => {}} />
    )
    expect(getByText('Protect your assets with Face ID or your fingerprint')).toBeTruthy()
    expect(
      queryByText(
        'This device has no Face ID or fingerprint set up, so your wallet key is protected by your device passcode only.'
      )
    ).toBeNull()
  })

  it('XR-114: never shows the unconditional Face ID/fingerprint promise when provisioning will be degraded', () => {
    const { getByText, queryByText } = render(
      <BiometricAdvisoryModal visible degraded onCancel={() => {}} onContinue={() => {}} />
    )
    expect(queryByText('Protect your assets with Face ID or your fingerprint')).toBeNull()
    expect(
      getByText(
        'This device has no Face ID or fingerprint set up, so your wallet key is protected by your device passcode only.'
      )
    ).toBeTruthy()
  })
})
