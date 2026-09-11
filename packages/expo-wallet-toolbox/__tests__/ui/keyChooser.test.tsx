import React from 'react'
import { fireEvent, render } from '@testing-library/react-native'

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} })
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return ({ children, onPress, ...props }: any) => React.createElement(Pressable, { onPress, ...props }, children)
})

import { KeyChooser, vaultKeyLabel } from '../../ui/components/vault/KeyChooser'

const KEYS = [
  { serial: '12340001', slot: 0x82, pubkey: '02' + 'a'.repeat(64), nickname: 'Desk', enrolledAt: 1 },
  { serial: '12340002', slot: 0x82, pubkey: '02' + 'b'.repeat(64), nickname: 'Safe', enrolledAt: 2 }
]

test('vaultKeyLabel is nickname · …serialTail4', () => {
  expect(vaultKeyLabel(KEYS[0])).toBe('Desk · …0001')
  expect(vaultKeyLabel({ nickname: 'X', serial: '7' })).toBe('X · …7')
})

test('renders one radio row per key, marks the selected one, reports a press', () => {
  const onSelect = jest.fn()
  const screen = render(<KeyChooser keys={KEYS} selected="12340002" onSelect={onSelect} />)
  const rows = screen.getAllByRole('radio')
  expect(rows).toHaveLength(2)
  expect(screen.getByText('Desk · …0001')).toBeTruthy()
  expect(screen.getByText('Safe · …0002')).toBeTruthy()
  expect(rows[0].props.accessibilityState).toEqual({ selected: false })
  expect(rows[1].props.accessibilityState).toEqual({ selected: true })

  fireEvent.press(screen.getByText('Desk · …0001'))
  expect(onSelect).toHaveBeenCalledWith('12340001')
})

test('with no selection nothing is marked', () => {
  const screen = render(<KeyChooser keys={KEYS} onSelect={() => {}} />)
  for (const row of screen.getAllByRole('radio')) {
    expect(row.props.accessibilityState).toEqual({ selected: false })
  }
})
