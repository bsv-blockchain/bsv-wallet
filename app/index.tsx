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
          pointerEvents="none"
          style={{ position: 'absolute', width: 8, height: 8, top: 0, left: 0 }}
        />
      ) : null}
    </View>
  )
}
