// The shared core's own Vault screen, unchanged: enrolling YubiKeys (two or
// more, with a PIN), adding and removing keys, recovery and every state a key
// ceremony can leave behind. Reached from Vault (app/vault/index.tsx).
import { Redirect } from 'expo-router'
import { isVaultEnabled } from '@bsv/expo-wallet-toolbox'
import { VaultScreen } from '@bsv/expo-wallet-toolbox/ui'

export default function VaultManage() {
  if (!isVaultEnabled()) return <Redirect href="/" />
  return <VaultScreen />
}
