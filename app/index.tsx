import React from 'react'
import { WalletHomeScreen, ProfileButton } from '@bsv/expo-wallet-toolbox/ui'

export default function Home() {
  return <WalletHomeScreen topLeft={<ProfileButton />} />
}
