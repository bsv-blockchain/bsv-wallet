// Troubleshooting: the shared core's wallet check, which its own flows send
// people to when something looks wrong (Nearby payments, Receive, Send), and
// the developer tools (app/developer.tsx) open.
import React from 'react'
import { WalletCheckScreen } from '@bsv/expo-wallet-toolbox/ui'

export default function WalletCheck() {
  return <WalletCheckScreen />
}
