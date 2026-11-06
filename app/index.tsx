import React from 'react'
import { View } from 'react-native'
import { isE2eBuild } from '@bsv/expo-wallet-toolbox'
import { WalletHomeScreen, ProfileButton } from '@bsv/expo-wallet-toolbox/ui'

export default function Home() {
  return (
    <View style={{ flex: 1 }}>
      <WalletHomeScreen topLeft={<ProfileButton />} />
      {isE2eBuild() ? (
        <View
          testID="e2e-harness"
          accessible
          accessibilityLabel="E2E testnet"
          importantForAccessibility="yes"
          collapsable={false}
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: 12,
            height: 12,
            top: 100,
            left: 8,
            zIndex: 999,
            backgroundColor: '#11AA55'
          }}
        />
      ) : null}
    </View>
  )
}
