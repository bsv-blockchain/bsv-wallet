import React from 'react'
import { Text } from 'react-native'
import { render } from '@testing-library/react-native'

import { AgentationGate } from '../utils/AgentationGate'

describe('AgentationGate', () => {
  it('renders children untouched when EXPO_PUBLIC_AGENTATION is unset', () => {
    const { getByText } = render(
      <AgentationGate>
        <Text>wallet</Text>
      </AgentationGate>
    )
    expect(getByText('wallet')).toBeTruthy()
  })

  it('does not load the package without the flag', () => {
    const loaded = Object.keys(require.cache ?? {}).some(k => k.includes('react-native-agentation'))
    expect(loaded).toBe(false)
  })
})
