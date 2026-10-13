// The shared core's vault transfer screen, unchanged (?direction=deposit or
// withdraw): moving BitcoinSV between spending and the vault, through the
// core's ceremony. The core's Vault screen links here by this path.
import { Redirect } from 'expo-router'
import { isVaultEnabled } from '@bsv/expo-wallet-toolbox'
import { VaultTransferScreen } from '@bsv/expo-wallet-toolbox/ui'

export default function VaultTransfer() {
  if (!isVaultEnabled()) return <Redirect href="/" />
  return <VaultTransferScreen />
}
