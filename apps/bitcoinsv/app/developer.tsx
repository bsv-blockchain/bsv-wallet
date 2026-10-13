// Developer tools (the prototype's app/(wallet)/settings/developer/page.tsx):
// the shared core's own wallet configuration
// screen, unchanged: the network, the ARC endpoint and its token, the message
// box server, how much a paired site may auto-spend, the trust network,
// storage, troubleshooting and the debugging log. From Settings → Advanced.
import React from 'react'
import { WalletConfigScreen } from '@bsv/expo-wallet-toolbox/ui'

export default function Developer() {
  // the app forgets wallets its own way (Settings → Forget wallet)
  return <WalletConfigScreen hideLogout />
}
